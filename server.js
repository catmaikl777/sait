// server.js - с добавлением поддержки голосовых сообщений
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { Pool } = require("pg");

// Настройка подключения к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err);
});

// Функции для работы с базой данных
const db = {
  async init() {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          session_id VARCHAR(100) UNIQUE NOT NULL,
          connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          disconnected_at TIMESTAMP NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          message_type VARCHAR(20) NOT NULL,
          content TEXT,
          target_user_id INTEGER REFERENCES users(id),
          file_name VARCHAR(255),
          file_type VARCHAR(100),
          file_size INTEGER,
          file_data BYTEA,
          voice_duration INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id ON user_sessions(session_id)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)`
      );

      await this.ensureFileColumns(client);
      console.log("✅ Database tables initialized successfully");
    } catch (error) {
      console.error("❌ Error initializing database:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async ensureFileColumns(client) {
    try {
      const columns = [
        "file_name",
        "file_type",
        "file_size",
        "file_data",
        "voice_duration",
      ];
      for (const column of columns) {
        try {
          await client.query(`SELECT ${column} FROM messages LIMIT 1`);
        } catch (error) {
          if (error.code === "42703") {
            console.log(`Adding ${column} column to messages table...`);
            const type =
              column === "file_size" || column === "voice_duration"
                ? "INTEGER"
                : column === "file_data"
                ? "BYTEA"
                : "VARCHAR(255)";
            await client.query(
              `ALTER TABLE messages ADD COLUMN ${column} ${type}`
            );
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      console.error("Error ensuring file columns:", error);
      throw error;
    }
  },

  // ИСПРАВЛЕНИЕ: Более безопасная очистка дублирующихся сессий
  async cleanupDuplicateSessions(userId, currentSessionId) {
    const client = await pool.connect();
    try {
      // Получаем все активные сессии пользователя
      const result = await client.query(
        "SELECT session_id FROM user_sessions WHERE user_id = $1 AND session_id != $2 AND disconnected_at IS NULL",
        [userId, currentSessionId]
      );

      const duplicateSessions = result.rows.map((row) => row.session_id);

      if (duplicateSessions.length > 0) {
        console.log(
          `🧹 Found ${duplicateSessions.length} duplicate sessions for user ${userId}:`,
          duplicateSessions
        );

        // Закрываем дублирующиеся сессии в базе данных
        await client.query(
          "UPDATE user_sessions SET disconnected_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND session_id != $2 AND disconnected_at IS NULL",
          [userId, currentSessionId]
        );

        // Закрываем дублирующиеся соединения в памяти
        duplicateSessions.forEach((sessionId) => {
          if (clients.has(sessionId)) {
            const clientData = clients.get(sessionId);
            try {
              if (clientData.ws.readyState === WebSocket.OPEN) {
                // ИСПРАВЛЕНИЕ: Используем специальный код для дублирующих сессий
                clientData.ws.close(
                  4000,
                  "Duplicate session closed by new connection"
                );
              }
            } catch (error) {
              console.error("Error closing duplicate session:", error);
            }
            clients.delete(sessionId);
          }
        });
      }

      return duplicateSessions.length;
    } catch (error) {
      console.error("Error in cleanupDuplicateSessions:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async findOrCreateUser(username) {
    const client = await pool.connect();
    try {
      let result = await client.query(
        "SELECT id, username FROM users WHERE username = $1",
        [username]
      );

      if (result.rows.length === 0) {
        result = await client.query(
          "INSERT INTO users (username) VALUES ($1) RETURNING id, username",
          [username]
        );
        console.log(`✅ New user created: ${username}`);
      } else {
        console.log(`✅ Existing user found: ${username}`);
      }

      await client.query(
        "UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1",
        [result.rows[0].id]
      );

      return result.rows[0];
    } catch (error) {
      console.error("Error in findOrCreateUser:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async createUserSession(userId, sessionId) {
    const client = await pool.connect();
    try {
      // ИСПРАВЛЕНИЕ: Сначала проверяем, существует ли уже сессия
      const existingSession = await client.query(
        "SELECT id FROM user_sessions WHERE session_id = $1",
        [sessionId]
      );

      if (existingSession.rows.length > 0) {
        // Если сессия уже существует, обновляем ее
        console.log(`🔄 Updating existing session: ${sessionId}`);
        await client.query(
          "UPDATE user_sessions SET user_id = $1, disconnected_at = NULL WHERE session_id = $2",
          [userId, sessionId]
        );
      } else {
        // Если сессии нет, создаем новую
        await client.query(
          "INSERT INTO user_sessions (user_id, session_id) VALUES ($1, $2)",
          [userId, sessionId]
        );
      }

      // Очищаем дублирующиеся сессии после создания/обновления
      await this.cleanupDuplicateSessions(userId, sessionId);

      return { sessionId, userId };
    } catch (error) {
      console.error("Error in createUserSession:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async endUserSession(sessionId) {
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE user_sessions SET disconnected_at = CURRENT_TIMESTAMP WHERE session_id = $1",
        [sessionId]
      );
    } catch (error) {
      console.error("Error in endUserSession:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async saveMessage(
    userId,
    messageType,
    content,
    targetUserId = null,
    fileData = null
  ) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO messages (user_id, message_type, content, target_user_id, file_data) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [userId, messageType, content, targetUserId, fileData]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error in saveMessage:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async saveFileMessage(
    userId,
    filename,
    filetype,
    size,
    data,
    targetUserId = null,
    voiceDuration = null
  ) {
    const client = await pool.connect();
    try {
      await this.ensureFileColumns(client);
      const buffer = Buffer.from(data, "base64");

      const result = await client.query(
        `INSERT INTO messages (user_id, message_type, content, file_name, file_type, file_size, file_data, target_user_id, voice_duration) 
         VALUES ($1, 'file', $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
        [
          userId,
          filename,
          filename,
          filetype,
          size,
          buffer,
          targetUserId,
          voiceDuration,
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error in saveFileMessage:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async getMessageHistory(limit = 100) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT m.id, m.message_type as type, m.content, m.created_at, 
                u.username as name, u.id as user_id, m.target_user_id,
                m.file_name, m.file_type, m.file_size, m.voice_duration
         FROM messages m 
         JOIN users u ON m.user_id = u.id
         WHERE (m.message_type != 'private' OR m.target_user_id IS NULL)
         ORDER BY m.created_at DESC LIMIT $1`,
        [limit]
      );

      return result.rows.reverse().map((row) => {
        const message = {
          type: row.type,
          name: row.name,
          user_id: row.user_id,
          created_at: row.created_at,
          content: row.content,
        };

        if (row.type === "file") {
          message.file_name = row.file_name;
          message.file_type = row.file_type;
          message.file_size = row.file_size;
          message.voice_duration = row.voice_duration;
        }

        return message;
      });
    } catch (error) {
      console.error("Error in getMessageHistory:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async getOnlineUsers() {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT u.id, u.username 
        FROM users u
        JOIN user_sessions us ON u.id = us.user_id
        WHERE us.disconnected_at IS NULL 
        ORDER BY u.username
      `);

      // Дополнительная проверка: фильтруем пользователей, которые действительно онлайн в памяти
      const onlineUsers = result.rows.filter((user) => {
        return Array.from(clients.values()).some(
          (client) =>
            client.userId === user.id && client.ws.readyState === WebSocket.OPEN
        );
      });

      return onlineUsers;
    } catch (error) {
      console.error("Error in getOnlineUsers:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async getUserById(userId) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT id, username FROM users WHERE id = $1",
        [userId]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error in getUserById:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async isUsernameAvailable(userId, newUsername) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT id FROM users WHERE username = $1 AND id != $2",
        [newUsername, userId]
      );
      return result.rows.length === 0;
    } catch (error) {
      console.error("Error in isUsernameAvailable:", error);
      throw error;
    } finally {
      client.release();
    }
  },

  async updateUsername(userId, newUsername) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "UPDATE users SET username = $1 WHERE id = $2 RETURNING username",
        [newUsername, userId]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error in updateUsername:", error);
      throw error;
    } finally {
      client.release();
    }
  },
};

//////////////////

// HTTP сервер
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://fire-catchat.vercel.app/");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, DELETE"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        clients: clients.size,
        rooms: rooms.size,
        database: "connected",
      })
    );
    return;
  }

  let filePath = req.url;
  if (filePath === "/") filePath = "/index.html";

  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(__dirname, safePath);

  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(__dirname, "index.html");
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("File not found");
      }
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".json": "application/json",
      ".txt": "text/plain; charset=utf-8",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });

    fs.createReadStream(fullPath).pipe(res);
  });
});

// WebSocket сервер
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  clientTracking: true,
});

const clients = new Map();
const rooms = new Map();

function broadcast(data, exceptSessionId = null) {
  const message = JSON.stringify(data);
  clients.forEach((client, sessionId) => {
    if (
      sessionId !== exceptSessionId &&
      client.ws.readyState === WebSocket.OPEN
    ) {
      try {
        client.ws.send(message);
      } catch (error) {
        console.error(`Error broadcasting to client ${sessionId}:`, error);
      }
    }
  });
}

function broadcastToRoom(roomId, data, exceptSessionId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const message = JSON.stringify(data);
  room.users.forEach((userInfo, sessionId) => {
    if (sessionId !== exceptSessionId && clients.has(sessionId)) {
      const client = clients.get(sessionId);
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(message);
        } catch (error) {
          console.error(
            `Error broadcasting to room client ${sessionId}:`,
            error
          );
        }
      }
    }
  });
}

async function broadcastUsers() {
  try {
    const onlineUsers = await db.getOnlineUsers();
    const usersData = onlineUsers.map((user) => ({
      id: user.id,
      name: user.username,
      isOnline: true,
    }));

    console.log(`📊 Broadcasting ${usersData.length} online users`);
    broadcast({ type: "users", users: usersData });
  } catch (error) {
    console.error("Error broadcasting users:", error);
  }
}

wss.on("connection", async (ws, req) => {
  const sessionId = `session_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  let currentUser = null;
  let userId = null;

  console.log(`🔌 New WebSocket connection: ${sessionId}`);

  try {
    // ИСПРАВЛЕНИЕ: НЕ создаем сессию сразу, только сохраняем в памяти
    clients.set(sessionId, { ws, user: null, userId: null, sessionId });

    // Отправляем историю и инициализацию без имени
    const history = await db.getMessageHistory();
    ws.send(JSON.stringify({ type: "history", history }));
    ws.send(
      JSON.stringify({
        type: "init",
        id: null, // Пока нет ID
        name: null, // Пока нет имени
        sessionId: sessionId,
      })
    );

    console.log(
      `✅ New connection established with session ${sessionId}, waiting for name...`
    );
  } catch (error) {
    console.error("❌ Error during connection setup:", error);
    try {
      ws.close(1011, "Server error during connection setup");
    } catch (closeError) {
      console.error("Error closing connection:", closeError);
    }
    return;
  }

  ws.on("message", async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());

      if (!message || typeof message !== "object") {
        throw new Error("Invalid message format");
      }

      if (!message.type) {
        throw new Error("Message type is required");
      }
    } catch (error) {
      console.error("Error parsing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          text: "❌ Неверный формат сообщения",
        })
      );
      return;
    }

    try {
      switch (message.type) {
        case "setName":
          if (message.name && message.name.trim()) {
            const newName = message.name.trim();

            if (newName.length > 50) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Имя слишком длинное (максимум 50 символов)",
                })
              );
              break;
            }

            if (!/^[a-zA-Zа-яА-Я0-9_-\s]+$/.test(newName)) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Имя содержит недопустимые символы",
                })
              );
              break;
            }

            try {
              // Создаем/находим пользователя
              const user = await db.findOrCreateUser(newName);

              // Обновляем данные в памяти
              currentUser = user;
              userId = user.id;

              const clientData = clients.get(sessionId);
              if (clientData) {
                clientData.user = user;
                clientData.userId = userId;
              }

              // ИСПРАВЛЕНИЕ: Создаем сессию только сейчас, когда есть userId
              await db.createUserSession(userId, sessionId);

              // Проверяем, было ли у пользователя предыдущее имя
              const oldName = clientData?.user?.username || newName;

              // Если имя изменилось, обновляем в базе
              if (user.username !== newName) {
                await db.updateUsername(userId, newName);
                user.username = newName;
              }

              // Очищаем дублирующиеся сессии
              const closedCount = await db.cleanupDuplicateSessions(
                userId,
                sessionId
              );

              if (closedCount > 0) {
                console.log(
                  `🔄 Closed ${closedCount} duplicate sessions after name change`
                );
              }

              // Отправляем подтверждение клиенту
              ws.send(
                JSON.stringify({
                  type: "name_updated",
                  userId: userId,
                  newName: newName,
                })
              );

              // Если это первое установление имени (не смена), уведомляем о входе
              if (!clientData?.user?.username) {
                await db.saveMessage(
                  userId,
                  "system",
                  `${newName} вошёл в чат`
                );
                broadcast(
                  { type: "system", text: `🐱 ${newName} вошёл в чат` },
                  sessionId
                );
                await broadcastUsers();
              } else {
                // Если это смена имени
                await db.saveMessage(
                  userId,
                  "action",
                  `${oldName} сменил имя на ${newName}`
                );
                broadcast({
                  type: "action",
                  name: oldName,
                  text: `сменил имя на ${newName}`,
                });
                await broadcastUsers();
              }

              ws.send(
                JSON.stringify({
                  type: "system",
                  text: `✅ Имя успешно установлено: ${newName}`,
                })
              );

              console.log(
                `✅ User ${newName} (${userId}) name set successfully`
              );
            } catch (error) {
              console.error("Error setting username:", error);
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Ошибка при установке имени",
                })
              );
            }
          }
          break;

        case "message":
          if (message.text && message.text.trim()) {
            const text = message.text.trim();

            if (text.length > 1000) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Сообщение слишком длинное (максимум 1000 символов)",
                })
              );
              return;
            }

            const savedMessage = await db.saveMessage(userId, "message", text);
            broadcast({
              type: "message",
              id: userId,
              name: currentUser.username,
              text: text,
              ts: savedMessage.created_at,
            });
          }
          break;

        case "file":
          if (message.filename && message.data) {
            try {
              if (message.size > 10 * 1024 * 1024) {
                ws.send(
                  JSON.stringify({
                    type: "system",
                    text: "❌ Файл слишком большой (максимум 10MB)",
                  })
                );
                return;
              }

              const allowedTypes = [
                "image/jpeg",
                "image/png",
                "image/gif",
                "image/webp",
                "video/mp4",
                "video/webm",
                "video/ogg",
                // Добавьте эти аудио форматы:
                "audio/webm",
                "audio/webm;codecs=opus",
                "audio/ogg",
                "audio/ogg;codecs=opus",
                "audio/mp4",
                "audio/mpeg",
                "audio/wav",
                "audio/x-wav",
                "audio/aac",
                "audio/mp3",
                "application/pdf",
                "text/plain",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              ];

              // Более гибкая проверка для аудио форматов
              const isAllowedType = allowedTypes.some((allowedType) => {
                if (
                  allowedType.includes("audio") &&
                  message.filetype.includes("audio")
                ) {
                  return true;
                }
                return message.filetype === allowedType;
              });

              if (!isAllowedType) {
                ws.send(
                  JSON.stringify({
                    type: "system",
                    text: "❌ Тип файла не поддерживается",
                  })
                );
                return;
              }

              // Сохраняем голосовое сообщение с длительностью
              await db.saveFileMessage(
                userId,
                message.filename,
                message.filetype,
                message.size,
                message.data,
                null,
                message.duration
              );

              broadcast({
                type: "file",
                id: userId,
                name: currentUser.username,
                filename: message.filename,
                filetype: message.filetype,
                size: message.size,
                data: message.data,
                duration: message.duration,
                ts: Date.now(),
              });
            } catch (error) {
              console.error("Error saving file:", error);
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Ошибка при отправке файла",
                })
              );
            }
          }
          break;

        case "action":
          if (message.text && message.text.trim()) {
            const text = message.text.trim();
            await db.saveMessage(userId, "action", text);
            broadcast({
              type: "action",
              name: currentUser.username,
              text: text,
            });
          }
          break;

        case "reaction":
          if (message.emoji) {
            await db.saveMessage(userId, "reaction", message.emoji);
            broadcast({
              type: "reaction",
              name: currentUser.username,
              emoji: message.emoji,
            });
          }
          break;

        case "leave":
          try {
            // Помечаем сессию как завершённую в БД
            await db.endUserSession(sessionId);

            if (currentUser) {
              await db.saveMessage(userId, "system", `${currentUser.username} вышел из чата`);
              broadcast({ type: "system", text: `🐱 ${currentUser.username} вышел из чата` });
              await broadcastUsers();
            }
          } catch (error) {
            console.error("Error handling leave message:", error);
          }
          break;

        case "private":
          if (message.to && message.text && message.text.trim()) {
            const targetUser = await db.getUserById(message.to);
            if (targetUser) {
              const text = message.text.trim();
              await db.saveMessage(userId, "private", text, message.to);

              let targetClient = null;
              clients.forEach((client, sid) => {
                if (client.userId === message.to) {
                  targetClient = client;
                }
              });

              if (
                targetClient &&
                targetClient.ws.readyState === WebSocket.OPEN
              ) {
                targetClient.ws.send(
                  JSON.stringify({
                    type: "private",
                    name: currentUser.username,
                    text: text,
                    fromUserId: userId,
                  })
                );

                ws.send(JSON.stringify({ type: "private_sent" }));
              } else {
                ws.send(
                  JSON.stringify({
                    type: "system",
                    text: "❌ Пользователь не в сети",
                  })
                );
              }
            }
          }
          break;

        // WebRTC сигнальные сообщения
        case "create_room":
          const roomId = `room_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
          rooms.set(roomId, {
            users: new Map([
              [
                sessionId,
                {
                  userId,
                  userName: currentUser.username,
                  sessionId: sessionId,
                },
              ],
            ]),
            creator: sessionId,
            createdAt: Date.now(),
            isGroupCall: true,
            isActive: true, // ДОБАВИТЬ: флаг активного звонка
          });

          console.log(`📞 Room created: ${roomId} by ${currentUser.username}`);

          // Отправляем создателю подтверждение
          ws.send(
            JSON.stringify({
              type: "room_created",
              roomId: roomId,
              message: "Групповой звонок создан. Ожидаем участников...",
            })
          );

          // НЕ отправляем приглашение всем сразу - вместо этого уведомляем о создании комнаты
          broadcast(
            {
              type: "group_call_started",
              roomId: roomId,
              fromUserId: userId,
              fromUserName: currentUser.username,
            },
            sessionId
          );
          break;

        case "join_group_call":
          if (message.roomId && rooms.has(message.roomId)) {
            const room = rooms.get(message.roomId);

            if (!room.isActive) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Этот звонок уже завершен",
                })
              );
              break;
            }

            if (!room.users.has(sessionId)) {
              room.users.set(sessionId, {
                userId,
                userName: currentUser.username,
                sessionId: sessionId,
              });

              console.log(
                `👤 User ${currentUser.username} joined group call ${message.roomId}`
              );

              // Отправляем новому участнику полный список пользователей
              const usersInRoom = Array.from(room.users.entries()).map(
                ([sid, user]) => ({
                  sessionId: sid,
                  userId: user.userId,
                  userName: user.userName,
                })
              );

              ws.send(
                JSON.stringify({
                  type: "room_users",
                  users: usersInRoom,
                  roomId: message.roomId,
                })
              );

              // ИСПРАВЛЕНИЕ: Оповещаем всех участников о новом пользователе
              broadcastToRoom(
                message.roomId,
                {
                  type: "user_joined",
                  userId: userId,
                  userName: currentUser.username,
                  roomId: message.roomId,
                  sessionId: sessionId,
                },
                sessionId // исключаем нового пользователя из этого сообщения
              );

              // ИСПРАВЛЕНИЕ: Отправляем обновленный список всем участникам
              broadcastToRoom(message.roomId, {
                type: "room_users",
                users: usersInRoom,
                roomId: message.roomId,
              });

              // Уведомляем о присоединении
              broadcastToRoom(message.roomId, {
                type: "system",
                text: `👤 ${currentUser.username} присоединился к звонку`,
              });
            }
          } else {
            ws.send(
              JSON.stringify({
                type: "system",
                text: "❌ Звонок не найден или уже завершен",
              })
            );
          }
          break;

        case "start_individual_call":
          if (message.targetUserId) {
            const targetClient = Array.from(clients.values()).find(
              (client) => client.userId === message.targetUserId
            );
            if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
              const roomId = `room_${Date.now()}_${Math.random()
                .toString(36)
                .substr(2, 9)}`;
              rooms.set(roomId, {
                users: new Map([
                  [
                    sessionId,
                    {
                      userId,
                      userName: currentUser.username,
                      sessionId: sessionId,
                    },
                  ],
                ]),
                creator: sessionId,
                createdAt: Date.now(),
                isGroupCall: false,
                isActive: true, // ДОБАВЬТЕ ЭТУ СТРОЧКУ
              });

              console.log(
                `📞 Individual call room created: ${roomId} by ${currentUser.username}`
              );

              // Сначала отправляем подтверждение инициатору
              ws.send(
                JSON.stringify({
                  type: "call_started", // УБЕДИТЕСЬ ЧТО ТИП call_started
                  roomId: roomId,
                  targetUserName: targetClient.user.username,
                  message: `Вызываем ${targetClient.user.username}...`,
                })
              );

              // Затем отправляем приглашение целевому пользователю
              targetClient.ws.send(
                JSON.stringify({
                  type: "call_invite",
                  fromUserId: userId,
                  fromUserName: currentUser.username,
                  roomId: roomId,
                  isGroupCall: false,
                })
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: "system",
                  text: "❌ Пользователь не в сети",
                })
              );
            }
          }
          break;

        // В обработчике сообщения "join_room" добавьте:
        case "join_room":
          if (message.roomId && rooms.has(message.roomId)) {
            const room = rooms.get(message.roomId);
            if (!room.users.has(sessionId)) {
              room.users.set(sessionId, {
                userId,
                userName: currentUser.username,
                sessionId: sessionId,
              });

              console.log(
                `👤 User ${currentUser.username} joined room ${message.roomId}`
              );

              // ИСПРАВЛЕНИЕ: Сразу отправляем полный список пользователей новому участнику
              const usersInRoom = Array.from(room.users.entries()).map(
                ([sid, user]) => ({
                  sessionId: sid,
                  userId: user.userId,
                  userName: user.userName,
                })
              );

              // Отправляем новому участнику полный список
              ws.send(
                JSON.stringify({
                  type: "room_users",
                  users: usersInRoom,
                  roomId: message.roomId,
                })
              );

              // Оповещаем всех о новом участнике
              broadcastToRoom(
                message.roomId,
                {
                  type: "user_joined",
                  userId: userId,
                  userName: currentUser.username,
                  roomId: message.roomId,
                  sessionId: sessionId,
                },
                sessionId
              );

              // ИСПРАВЛЕНИЕ: Отправляем обновленный список всем участникам
              broadcastToRoom(message.roomId, {
                type: "room_users",
                users: usersInRoom,
                roomId: message.roomId,
              });
            }
          }
          break;

        case "get_room_users":
          if (message.roomId && rooms.has(message.roomId)) {
            const room = rooms.get(message.roomId);
            const usersInRoom = Array.from(room.users.entries()).map(
              ([sid, user]) => ({
                sessionId: sid,
                userId: user.userId,
                userName: user.userName,
              })
            );

            ws.send(
              JSON.stringify({
                type: "room_users",
                users: usersInRoom,
                roomId: message.roomId,
              })
            );
          }
          break;

        case "webrtc_offer":
          if (message.roomId && message.targetSessionId && message.offer) {
            const targetClient = clients.get(message.targetSessionId);
            if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
              console.log(
                `📡 Forwarding WebRTC offer from ${sessionId} to ${message.targetSessionId}`
              );
              targetClient.ws.send(
                JSON.stringify({
                  type: "webrtc_offer",
                  fromSessionId: sessionId,
                  fromUserId: userId,
                  fromUserName: currentUser.username,
                  roomId: message.roomId,
                  offer: message.offer,
                })
              );
            } else {
              console.log(
                `❌ Target client not found: ${message.targetSessionId}`
              );
            }
          }
          break;

        case "webrtc_answer":
          if (message.roomId && message.targetSessionId && message.answer) {
            const targetClient = clients.get(message.targetSessionId);
            if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
              console.log(
                `📡 Forwarding WebRTC answer from ${sessionId} to ${message.targetSessionId}`
              );
              targetClient.ws.send(
                JSON.stringify({
                  type: "webrtc_answer",
                  fromSessionId: sessionId,
                  fromUserId: userId,
                  roomId: message.roomId,
                  answer: message.answer,
                })
              );
            }
          }
          break;

        case "webrtc_ice_candidate":
          if (message.roomId && message.targetSessionId && message.candidate) {
            const targetClient = clients.get(message.targetSessionId);
            if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
              targetClient.ws.send(
                JSON.stringify({
                  type: "webrtc_ice_candidate",
                  fromSessionId: sessionId,
                  fromUserId: userId,
                  roomId: message.roomId,
                  candidate: message.candidate,
                })
              );
            }
          }
          break;

        case "leave_room":
          if (message.roomId && rooms.has(message.roomId)) {
            const room = rooms.get(message.roomId);
            const userName = currentUser.username;

            room.users.delete(sessionId);

            console.log(`👤 User ${userName} left room ${message.roomId}`);

            broadcastToRoom(
              message.roomId,
              {
                type: "user_left",
                userId: userId,
                userName: userName,
                roomId: message.roomId,
                sessionId: sessionId,
              },
              sessionId
            );

            broadcastToRoom(message.roomId, {
              type: "system",
              text: `👤 ${userName} покинул звонок`,
            });

            // Если комната пуста, удаляем её через 30 секунд
            if (room.users.size === 0) {
              console.log(
                `🗑️ Room ${message.roomId} is empty, scheduling cleanup`
              );
              room.isActive = false;
              setTimeout(() => {
                if (
                  rooms.has(message.roomId) &&
                  rooms.get(message.roomId).users.size === 0
                ) {
                  rooms.delete(message.roomId);
                  console.log(`🗑️ Room ${message.roomId} cleaned up`);
                }
              }, 30000);
            }
          }
          break;

        case "end_call":
          if (message.roomId && rooms.has(message.roomId)) {
            const room = rooms.get(message.roomId);
            const userName = currentUser.username;

            console.log(
              `📞 Call ended by ${userName} in room ${message.roomId}`
            );

            // Отправляем всем участникам уведомление о завершении звонка
            broadcastToRoom(
              message.roomId,
              {
                type: "call_ended",
                endedBy: userName,
                roomId: message.roomId,
                message: `Звонок завершен пользователем ${userName}`,
              },
              sessionId
            );

            // Устанавливаем флаг неактивности и очищаем комнату
            room.isActive = false;
            room.users.clear();

            // Удаляем комнату немедленно
            setTimeout(() => {
              if (rooms.has(message.roomId)) {
                rooms.delete(message.roomId);
                console.log(`🗑️ Room ${message.roomId} deleted after call end`);
              }
            }, 5000);
          }
          break;

        case "typing":
          if (message.roomId) {
            broadcastToRoom(
              message.roomId,
              {
                type: "typing",
                userId: userId,
                userName: currentUser.username,
                isTyping: message.isTyping,
              },
              sessionId
            );
          } else {
            broadcast(
              {
                type: "typing",
                userId: userId,
                userName: currentUser.username,
                isTyping: message.isTyping,
              },
              sessionId
            );
          }
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        default:
          console.log("Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          text: "❌ Ошибка обработки сообщения",
        })
      );
    }
  });

  ws.on("close", async (code, reason) => {
    console.log(
      `🔌 WebSocket connection closed: ${sessionId} (user: ${
        currentUser?.username || "unknown"
      })`,
      code,
      reason?.toString()
    );

    if (
      code === 4000 &&
      reason === "Duplicate session closed by new connection"
    ) {
      console.log(`🔄 Duplicate session ${sessionId} closed normally`);
      clients.delete(sessionId);
      return;
    }

    try {
      // Удаляем из комнат
      rooms.forEach((room, roomId) => {
        if (room.users.has(sessionId)) {
          const userName = currentUser?.username || "Unknown";
          room.users.delete(sessionId);

          try {
            broadcastToRoom(
              roomId,
              {
                type: "user_left",
                userId: userId,
                userName: userName,
                roomId: roomId,
                sessionId: sessionId,
              },
              sessionId
            );

            if (room.users.size > 0) {
              const usersInRoom = Array.from(room.users.entries()).map(
                ([sid, user]) => ({
                  sessionId: sid,
                  userId: user.userId,
                  userName: user.userName,
                })
              );

              broadcastToRoom(roomId, {
                type: "room_users",
                users: usersInRoom,
                roomId: roomId,
              });
            } else {
              rooms.delete(roomId);
            }
          } catch (error) {
            console.error("Error broadcasting user left:", error);
          }
        }
      });

      const clientData = clients.get(sessionId);

      // ИСПРАВЛЕНИЕ: Завершаем сессию только если она была создана (есть userId)
      if (clientData && userId) {
        await db.endUserSession(sessionId);

        if (currentUser) {
          await db.saveMessage(
            userId,
            "system",
            `${currentUser.username} вышел из чата`
          );
          broadcast({
            type: "system",
            text: `🐱 ${currentUser.username} вышел из чата`,
          });
          await broadcastUsers();

          console.log(
            `✅ User ${currentUser.username} (${userId}) disconnected, session ${sessionId} removed`
          );
        }
      }

      // Всегда удаляем из памяти
      clients.delete(sessionId);
      console.log(`✅ Session ${sessionId} removed from memory`);
    } catch (error) {
      console.error("❌ Error during connection cleanup:", error);
    }
  });

  ws.on("error", (error) => {
    console.error(`❌ WebSocket error for session ${sessionId}:`, error);
  });
});

// Очистка неактивных комнат каждые 5 минут
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  rooms.forEach((room, roomId) => {
    // Удаляем комнаты, которые неактивны более 1 часа
    if (!room.isActive || now - room.createdAt > 3600000) {
      rooms.delete(roomId);
      cleanedCount++;
      console.log(`🧹 Cleaned up inactive room: ${roomId}`);
    }
  });

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} inactive rooms`);
  }
}, 300000);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");

  // Закрываем все WebSocket соединения
  clients.forEach((client, sessionId) => {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1001, "Server shutting down");
      }
    } catch (error) {
      console.error(`Error closing client ${sessionId}:`, error);
    }
  });

  // Закрываем WebSocket сервер
  wss.close(() => {
    console.log("✅ WebSocket server closed");
  });

  // Закрываем HTTP сервер
  server.close(async () => {
    console.log("✅ HTTP server closed");

    // Закрываем пул соединений с базой данных
    try {
      await pool.end();
      console.log("✅ Database connections closed");
    } catch (error) {
      console.error("Error closing database connections:", error);
    }

    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.log("⚠️ Forcing shutdown after timeout");
    process.exit(1);
  }, 10000);
});

// Запуск сервера
const PORT = process.env.PORT || 10000;

async function startServer() {
  try {
    await db.init();
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 WebSocket server ready for connections`);
      console.log(
        `💾 Database: ${
          process.env.DATABASE_URL ? "Connected" : "Not configured"
        }`
      );
      console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
