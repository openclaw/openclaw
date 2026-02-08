import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

export type TelegramHistoryDirection = "inbound" | "outbound";

export type TelegramHistoryMessage = {
  id: number;
  accountId: string;
  chatId: string;
  threadId?: string;
  messageId?: number;
  direction: TelegramHistoryDirection;
  dateMs: number;
  senderId?: string;
  senderUsername?: string;
  senderName?: string;
  text: string;
  wasMention?: boolean;
  isGroup?: boolean;
  sessionKey?: string;
};

type DbHandle = {
  db: import("node:sqlite").DatabaseSync;
  prepared: {
    insert: import("node:sqlite").StatementSync;
    pruneByChat: import("node:sqlite").StatementSync;
    readRecent: import("node:sqlite").StatementSync;
    readBeforeMessageId: import("node:sqlite").StatementSync;
  };
};

const STORE_VERSION = 1;
const dbCache = new Map<string, DbHandle>();

function resolveTelegramHistoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "telegram", "history.sqlite");
}

async function openDb(params: { env?: NodeJS.ProcessEnv }): Promise<DbHandle> {
  const dbPath = resolveTelegramHistoryDbPath(params.env);
  const cached = dbCache.get(dbPath);
  if (cached) {
    return cached;
  }
  await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  // Ensure file permissions are private (create if missing)
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, "", { encoding: "utf-8" });
    await fs.chmod(dbPath, 0o600);
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, {
    open: true,
  });

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_history_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Minimal schema for message history
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      message_id INTEGER,
      direction TEXT NOT NULL,
      date_ms INTEGER NOT NULL,
      sender_id TEXT,
      sender_username TEXT,
      sender_name TEXT,
      text TEXT NOT NULL,
      was_mention INTEGER,
      is_group INTEGER,
      session_key TEXT,
      raw_json TEXT
    );
  `);

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS telegram_messages_uniq ON telegram_messages(account_id, chat_id, COALESCE(thread_id, ''), COALESCE(message_id, -1), direction);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS telegram_messages_recent ON telegram_messages(account_id, chat_id, COALESCE(thread_id, ''), date_ms DESC, id DESC);`,
  );

  // Store version
  const metaGet = db.prepare("SELECT value FROM telegram_history_meta WHERE key = 'version'");
  const row = metaGet.get() as { value?: string } | undefined;
  if (!row?.value) {
    const metaSet = db.prepare(
      "INSERT OR REPLACE INTO telegram_history_meta(key, value) VALUES ('version', ?)",
    );
    metaSet.run(String(STORE_VERSION));
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO telegram_messages(
      account_id, chat_id, thread_id, message_id, direction, date_ms,
      sender_id, sender_username, sender_name,
      text, was_mention, is_group, session_key, raw_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?
    );
  `);

  const pruneByChat = db.prepare(`
    DELETE FROM telegram_messages
    WHERE account_id = ?
      AND chat_id = ?
      AND COALESCE(thread_id, '') = COALESCE(?, '')
      AND id NOT IN (
        SELECT id FROM telegram_messages
        WHERE account_id = ?
          AND chat_id = ?
          AND COALESCE(thread_id, '') = COALESCE(?, '')
        ORDER BY date_ms DESC, id DESC
        LIMIT ?
      );
  `);

  const readRecent = db.prepare(`
    SELECT id, account_id, chat_id, thread_id, message_id, direction, date_ms,
           sender_id, sender_username, sender_name, text, was_mention, is_group, session_key
    FROM telegram_messages
    WHERE account_id = ? AND chat_id = ? AND COALESCE(thread_id, '') = COALESCE(?, '')
    ORDER BY date_ms DESC, id DESC
    LIMIT ?;
  `);

  const readBeforeMessageId = db.prepare(`
    SELECT id, account_id, chat_id, thread_id, message_id, direction, date_ms,
           sender_id, sender_username, sender_name, text, was_mention, is_group, session_key
    FROM telegram_messages
    WHERE account_id = ? AND chat_id = ? AND COALESCE(thread_id, '') = COALESCE(?, '')
      AND message_id IS NOT NULL
      AND message_id < ?
    ORDER BY message_id DESC, date_ms DESC, id DESC
    LIMIT ?;
  `);

  const handle: DbHandle = {
    db,
    prepared: { insert, pruneByChat, readRecent, readBeforeMessageId },
  };
  dbCache.set(dbPath, handle);
  return handle;
}

export async function recordTelegramHistoryMessage(params: {
  env?: NodeJS.ProcessEnv;
  accountId: string;
  chatId: string | number;
  threadId?: string | number;
  messageId?: number;
  direction: TelegramHistoryDirection;
  dateMs: number;
  senderId?: string;
  senderUsername?: string;
  senderName?: string;
  text: string;
  wasMention?: boolean;
  isGroup?: boolean;
  sessionKey?: string;
  rawJson?: string;
  maxMessagesPerChat?: number;
}): Promise<void> {
  const handle = await openDb({ env: params.env });
  const maxMessagesPerChat =
    typeof params.maxMessagesPerChat === "number" && params.maxMessagesPerChat > 0
      ? Math.floor(params.maxMessagesPerChat)
      : null;

  handle.prepared.insert.run(
    params.accountId,
    String(params.chatId),
    params.threadId != null ? String(params.threadId) : null,
    typeof params.messageId === "number" ? params.messageId : null,
    params.direction,
    params.dateMs,
    params.senderId ?? null,
    params.senderUsername ?? null,
    params.senderName ?? null,
    params.text,
    params.wasMention ? 1 : 0,
    params.isGroup ? 1 : 0,
    params.sessionKey ?? null,
    params.rawJson ?? null,
  );

  if (maxMessagesPerChat) {
    handle.prepared.pruneByChat.run(
      params.accountId,
      String(params.chatId),
      params.threadId != null ? String(params.threadId) : null,
      params.accountId,
      String(params.chatId),
      params.threadId != null ? String(params.threadId) : null,
      maxMessagesPerChat,
    );
  }
}

type TelegramMessageRow = {
  id: number;
  account_id: string;
  chat_id: string;
  thread_id: string | null;
  message_id: number | null;
  direction: TelegramHistoryDirection;
  date_ms: number;
  sender_id: string | null;
  sender_username: string | null;
  sender_name: string | null;
  text: string;
  was_mention: number | null;
  is_group: number | null;
  session_key: string | null;
};

function mapRow(row: TelegramMessageRow): TelegramHistoryMessage {
  return {
    id: row.id,
    accountId: row.account_id,
    chatId: row.chat_id,
    threadId: row.thread_id ?? undefined,
    messageId: typeof row.message_id === "number" ? row.message_id : undefined,
    direction: row.direction,
    dateMs: row.date_ms,
    senderId: row.sender_id ?? undefined,
    senderUsername: row.sender_username ?? undefined,
    senderName: row.sender_name ?? undefined,
    text: row.text,
    wasMention: Boolean(row.was_mention),
    isGroup: Boolean(row.is_group),
    sessionKey: row.session_key ?? undefined,
  };
}

export async function readTelegramHistoryMessages(params: {
  env?: NodeJS.ProcessEnv;
  accountId: string;
  chatId: string | number;
  threadId?: string | number;
  limit: number;
  beforeMessageId?: number;
}): Promise<TelegramHistoryMessage[]> {
  const handle = await openDb({ env: params.env });
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
  const rows: TelegramMessageRow[] =
    typeof params.beforeMessageId === "number"
      ? (handle.prepared.readBeforeMessageId.all(
          params.accountId,
          String(params.chatId),
          params.threadId != null ? String(params.threadId) : null,
          params.beforeMessageId,
          limit,
        ) as unknown as TelegramMessageRow[])
      : (handle.prepared.readRecent.all(
          params.accountId,
          String(params.chatId),
          params.threadId != null ? String(params.threadId) : null,
          limit,
        ) as unknown as TelegramMessageRow[]);

  // Return in chronological order (oldest -> newest) for easier prompting
  return rows.map(mapRow).toReversed();
}
