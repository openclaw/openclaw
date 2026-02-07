/**
 * SQLite schema for experiential data storage.
 *
 * Creates tables for moments, session summaries, and compaction checkpoints.
 * Follows the same migration pattern as src/memory/memory-schema.ts.
 */

import type { DatabaseSync } from "node:sqlite";

export function ensureExperientialSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiential_moments (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      significance_total REAL NOT NULL DEFAULT 0,
      significance_emotional REAL NOT NULL DEFAULT 0,
      significance_uncertainty REAL NOT NULL DEFAULT 0,
      significance_relationship REAL NOT NULL DEFAULT 0,
      significance_consequential REAL NOT NULL DEFAULT 0,
      significance_reconstitution REAL NOT NULL DEFAULT 0,
      disposition TEXT NOT NULL DEFAULT 'buffered',
      reasons TEXT NOT NULL DEFAULT '[]',
      emotional_signature TEXT,
      anchors TEXT NOT NULL DEFAULT '[]',
      uncertainties TEXT NOT NULL DEFAULT '[]'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      session_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      topics TEXT NOT NULL DEFAULT '[]',
      emotional_arc TEXT,
      moment_count INTEGER NOT NULL DEFAULT 0,
      key_anchors TEXT NOT NULL DEFAULT '[]',
      open_uncertainties TEXT NOT NULL DEFAULT '[]',
      reconstitution_hints TEXT NOT NULL DEFAULT '[]'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_checkpoints (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      trigger TEXT NOT NULL,
      active_topics TEXT NOT NULL DEFAULT '[]',
      key_context_summary TEXT NOT NULL DEFAULT '',
      open_uncertainties TEXT NOT NULL DEFAULT '[]',
      conversation_anchors TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // Indexes for common queries
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_moments_session_key ON experiential_moments(session_key);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_moments_timestamp ON experiential_moments(timestamp);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_moments_disposition ON experiential_moments(disposition);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_moments_significance ON experiential_moments(significance_total);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_summaries_session_key ON session_summaries(session_key);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_ended_at ON session_summaries(ended_at);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_timestamp ON compaction_checkpoints(timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_session_key ON compaction_checkpoints(session_key);`,
  );
}

/** Add a column if it doesn't already exist (safe migration helper) */
export function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
