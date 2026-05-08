/**
 * This file was generated from the SQLite schema source.
 * Please do not edit it manually.
 */

export const OPENCLAW_AGENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS session_entries (
  session_key TEXT NOT NULL PRIMARY KEY,
  entry_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_session_entries_updated_at
  ON session_entries(updated_at DESC, session_key);

CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_transcript_events_updated
  ON transcript_events(session_id, created_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS transcript_event_identities (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT,
  has_parent INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  message_idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_id),
  FOREIGN KEY (session_id, seq) REFERENCES transcript_events(session_id, seq) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transcript_message_idempotency
  ON transcript_event_identities(session_id, message_idempotency_key)
  WHERE message_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_transcript_tail
  ON transcript_event_identities(session_id, seq DESC)
  WHERE has_parent = 1;

CREATE TABLE IF NOT EXISTS transcript_snapshots (
  session_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (session_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS vfs_entries (
  namespace TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_blob BLOB,
  metadata_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_vfs_entries_namespace
  ON vfs_entries(namespace, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS tool_artifacts (
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  blob BLOB,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  blob BLOB,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);

CREATE TABLE IF NOT EXISTS acp_parent_stream_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_acp_parent_stream_events_created
  ON acp_parent_stream_events(created_at DESC, run_id, seq);

CREATE TABLE IF NOT EXISTS trajectory_runtime_events (
  event_id INTEGER NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_trajectory_runtime_events_session
  ON trajectory_runtime_events(session_id, event_id);

CREATE INDEX IF NOT EXISTS idx_agent_trajectory_runtime_events_run
  ON trajectory_runtime_events(run_id, event_id)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_entries_expiry
  ON cache_entries(expires_at)
  WHERE expires_at IS NOT NULL;\n`;
