import type { DatabaseSync } from "node:sqlite";

/**
 * Ensures the observability database schema exists.
 * Creates tables for tracking ingested files and storing events.
 */
export function ensureObservabilitySchema(db: DatabaseSync): void {
  // Track ingestion progress per file
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_files (
      path TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Unified events table for all log sources
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_file TEXT NOT NULL,
      event_type TEXT NOT NULL,
      level TEXT,
      session_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      provider TEXT,
      model_id TEXT,
      role TEXT,
      message_preview TEXT,
      raw_json TEXT NOT NULL,
      ingested_at INTEGER NOT NULL
    );
  `);

  // Create indexes for common query patterns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);`);
}

/**
 * Updates the tracking record for a file after ingestion.
 */
export function updateTrackedFile(
  db: DatabaseSync,
  params: {
    path: string;
    sourceType: string;
    byteOffset: number;
    fileSize: number;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tracked_files (path, source_type, byte_offset, last_seen_at, file_size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       last_seen_at = excluded.last_seen_at,
       file_size = excluded.file_size`,
  ).run(params.path, params.sourceType, params.byteOffset, now, params.fileSize);
}

/**
 * Gets the tracked file record for resuming ingestion.
 */
export function getTrackedFile(
  db: DatabaseSync,
  filePath: string,
): { byteOffset: number; fileSize: number } | null {
  const row = db
    .prepare(`SELECT byte_offset, file_size FROM tracked_files WHERE path = ?`)
    .get(filePath) as { byte_offset: number; file_size: number } | undefined;

  if (!row) {
    return null;
  }
  return {
    byteOffset: row.byte_offset,
    fileSize: row.file_size,
  };
}

/**
 * Inserts a batch of events into the database using a transaction.
 */
export function insertEventsBatch(
  db: DatabaseSync,
  events: Array<{
    ts: string;
    sourceType: string;
    sourceFile: string;
    eventType: string;
    level?: string;
    sessionId?: string;
    agentId?: string;
    runId?: string;
    provider?: string;
    modelId?: string;
    role?: string;
    messagePreview?: string;
    rawJson: string;
  }>,
): void {
  if (events.length === 0) {
    return;
  }

  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO events (
      ts, source_type, source_file, event_type, level,
      session_id, agent_id, run_id, provider, model_id,
      role, message_preview, raw_json, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const event of events) {
      stmt.run(
        event.ts,
        event.sourceType,
        event.sourceFile,
        event.eventType,
        event.level ?? null,
        event.sessionId ?? null,
        event.agentId ?? null,
        event.runId ?? null,
        event.provider ?? null,
        event.modelId ?? null,
        event.role ?? null,
        event.messagePreview ?? null,
        event.rawJson,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
