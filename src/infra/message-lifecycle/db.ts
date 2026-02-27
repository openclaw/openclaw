import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const DB_FILENAME = "message-lifecycle.db";
const DB_CACHE = new Map<string, DatabaseSync>();
let registeredCleanupHook = false;

export function getLifecycleDb(stateDir?: string): DatabaseSync {
  const base = stateDir ?? resolveStateDir();
  const dbPath = path.resolve(path.join(base, DB_FILENAME));
  const cached = DB_CACHE.get(dbPath);
  if (cached) {
    return cached;
  }

  const { DatabaseSync } = requireNodeSqlite();
  let db: DatabaseSync;
  let cacheKey = dbPath;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dbPath);
  } catch (err) {
    const fallbackKey = `memory:${dbPath}`;
    const fallbackCached = DB_CACHE.get(fallbackKey);
    if (fallbackCached) {
      return fallbackCached;
    }
    db = new DatabaseSync(":memory:");
    cacheKey = fallbackKey;
    logVerbose(
      `message-lifecycle/db: failed to open ${dbPath}; using in-memory fallback (${String(err)})`,
    );
  }
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  ensureLifecycleSchema(db);
  registerCleanupHook();
  DB_CACHE.set(cacheKey, db);
  return db;
}

export function ensureLifecycleSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_turns (
      id                TEXT NOT NULL PRIMARY KEY,
      channel           TEXT NOT NULL DEFAULT '',
      account_id        TEXT NOT NULL DEFAULT '',
      external_id       TEXT,
      dedupe_key        TEXT,
      session_key       TEXT NOT NULL DEFAULT '',
      payload           TEXT NOT NULL DEFAULT '{}',
      route_channel     TEXT NOT NULL DEFAULT '',
      route_to          TEXT NOT NULL DEFAULT '',
      route_account_id  TEXT,
      route_thread_id   TEXT,
      route_reply_to_id TEXT,
      accepted_at       INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'accepted',
      attempt_count     INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   INTEGER NOT NULL,
      terminal_reason   TEXT,
      completed_at      INTEGER
    );
  `);

  db.exec("DROP INDEX IF EXISTS idx_message_turns_dedup");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_turns_dedup
      ON message_turns(dedupe_key)
      WHERE dedupe_key IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_turns_resume
      ON message_turns(status, next_attempt_at, updated_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_turns_session_status
      ON message_turns(session_key, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_outbox (
      id              TEXT NOT NULL PRIMARY KEY,
      turn_id         TEXT,
      channel         TEXT NOT NULL,
      account_id      TEXT NOT NULL DEFAULT '',
      target          TEXT NOT NULL DEFAULT '',
      payload         TEXT NOT NULL,
      queued_at       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      last_error      TEXT,
      error_class     TEXT,
      delivered_at    INTEGER,
      terminal_reason TEXT,
      completed_at    INTEGER,
      idempotency_key TEXT
    );
  `);

  db.exec("DROP INDEX IF EXISTS idx_message_outbox_idem");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_outbox_idem
      ON message_outbox(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_outbox_turn_status
      ON message_outbox(turn_id, status)
      WHERE turn_id IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_outbox_resume
      ON message_outbox(status, next_attempt_at, queued_at);
  `);
}

function registerCleanupHook(): void {
  if (registeredCleanupHook) {
    return;
  }
  registeredCleanupHook = true;
  process.once("exit", closeLifecycleDbCache);
}

export function closeLifecycleDbCache(): void {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // Ignore close failures.
    }
  }
  DB_CACHE.clear();
}

export function clearLifecycleDbCacheForTest(): void {
  closeLifecycleDbCache();
}

export function runLifecycleTransaction<T>(db: DatabaseSync, op: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = op();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failure; preserve root error.
    }
    throw err;
  }
}
