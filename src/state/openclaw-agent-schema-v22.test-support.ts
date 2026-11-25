import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// Exact deployed DDL from 00caa84ce72c0b4edd584cfa225bd262cd10ba49 (#153834).
export const OPENCLAW_AGENT_SCHEMA_V22_SQL = fs
  .readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v21.sql", import.meta.url),
    "utf8",
  )
  .replace(
    "  active_message_count INTEGER NOT NULL DEFAULT 0,\n",
    "  active_message_count INTEGER NOT NULL DEFAULT 0,\n  fts_row_count INTEGER,\n",
  )
  .replace(
    /(?=^CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5\()/mu,
    `CREATE TABLE IF NOT EXISTS session_transcript_fts_rows (
  session_id TEXT NOT NULL,
  fts_rowid INTEGER NOT NULL PRIMARY KEY
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_transcript_fts_rows_session
  ON session_transcript_fts_rows(session_id);

`,
  );

export function seedOpenClawAgentSchemaV22(database: DatabaseSync, agentId = "main"): void {
  database.exec(OPENCLAW_AGENT_SCHEMA_V22_SQL);
  database.exec("PRAGMA user_version = 22");
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 22, ?, '2026.9.5', 1, 1)`)
    .run(agentId);
}
