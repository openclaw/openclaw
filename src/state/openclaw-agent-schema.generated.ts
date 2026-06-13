/**
 * This file was generated from the SQLite schema source.
 * Please do not edit it manually.
 */

export const OPENCLAW_AGENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_expiry
  ON cache_entries(scope, expires_at, key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_cache_updated
  ON cache_entries(scope, updated_at DESC, key);

CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- QMD session-export cache: tracks per-JSONL identity so cold export walks can
-- skip unchanged transcripts across restarts. Keyed by absolute session file
-- path + export_dir + render_version so cache entries invalidate cleanly on
-- export-dir change or SESSION_EXPORT_RENDER_VERSION bumps.
CREATE TABLE IF NOT EXISTS qmd_session_export_cache (
  session_file TEXT NOT NULL,
  export_dir TEXT NOT NULL,
  render_version INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  hash TEXT NOT NULL,
  target TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_file, export_dir, render_version)
);

CREATE INDEX IF NOT EXISTS idx_qmd_export_cache_export_dir
  ON qmd_session_export_cache(export_dir, render_version);\n`;
