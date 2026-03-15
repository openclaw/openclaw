import type { DatabaseSync } from "node:sqlite";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // Tasks table — action items extracted from sessions or added by the agent/user.
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      text        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      due         TEXT,
      priority    TEXT NOT NULL DEFAULT 'normal',
      source      TEXT NOT NULL DEFAULT 'user',
      session_key TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);`);

  // Migration: add notified_at column for proactive task notifications.
  ensureTaskColumn(params.db, "notified_at", "TEXT");

  // Message log — structured record of every inbound and outbound message.
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS message_log (
      id            TEXT PRIMARY KEY,
      session_key   TEXT NOT NULL,
      direction     TEXT NOT NULL,
      role          TEXT NOT NULL,
      channel       TEXT,
      account_id    TEXT,
      sender_id     TEXT,
      sender_name   TEXT,
      recipient     TEXT,
      body          TEXT,
      media_url     TEXT,
      media_type    TEXT,
      media_urls    TEXT,
      chat_type     TEXT,
      group_subject TEXT,
      thread_id     TEXT,
      reply_to_id   TEXT,
      message_sid   TEXT,
      lang          TEXT,
      sentiment     TEXT,
      theme         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      enriched_at   TEXT
    );
  `);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_msglog_session ON message_log(session_key);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_msglog_channel ON message_log(channel);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_msglog_created ON message_log(created_at);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_msglog_sender  ON message_log(sender_id);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_msglog_dir     ON message_log(direction);`);

  // FTS5 for full-text search on message bodies.
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS message_log_fts USING fts5(\n` +
          `  body,\n` +
          `  id UNINDEXED,\n` +
          `  session_key UNINDEXED,\n` +
          `  channel UNINDEXED,\n` +
          `  sender_id UNINDEXED\n` +
          `);`,
      );
    } catch {
      // Non-fatal: FTS for message_log is optional.
    }
  }

  // Entities table — structured knowledge extracted from conversations.
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      name          TEXT NOT NULL,
      detail        TEXT,
      confidence    REAL NOT NULL DEFAULT 0.5,
      source        TEXT NOT NULL DEFAULT 'auto-capture',
      session_key   TEXT,
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
      superseded_by TEXT
    );
  `);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureTaskColumn(db: DatabaseSync, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
}
