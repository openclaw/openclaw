import {
  agentV19Schema,
  omitFrozenSqlSection,
} from "../state/openclaw-historical-imports.test-support.js";

// Restore the beta.6 lease layout and omit objects introduced by the v19 writer.
export function historicalV16AgentSchemaSql(): string {
  let sql = agentV19Schema()
    .replace(
      /(?=^CREATE TABLE IF NOT EXISTS session_nodes \()/mu,
      `CREATE TABLE IF NOT EXISTS state_leases (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_expiry
  ON state_leases(expires_at, scope, lease_key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_owner
  ON state_leases(owner, updated_at DESC);

`,
    )
    .replace("  entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1)),\n", "")
    .replace(/^ {2}owner_actor_type TEXT,\n[\s\S]*?(?=^ {2}parent_session_key TEXT,)/mu, "")
    .replace("  route_context_json TEXT,\n", "")
    .replace("  context_eligible INTEGER,\n", "")
    .replace(
      /^CREATE INDEX IF NOT EXISTS (?:idx_agent_session_nodes_active|idx_agent_session_windows_session_key|idx_agent_transcript_event_identity_sequence|idx_agent_transcript_context_pending)\n[^;]*;\n\n/gmu,
      "",
    )
    .replace(/\n-- Accepted input stays outside the active transcript[\s\S]*$/u, "");

  const table = "CREATE TABLE IF NOT EXISTS ";
  for (const [start, end] of [
    [`${table}session_progress_cards (`, `${table}heartbeat_outcomes (`],
    [`${table}message_tool_run_outcomes (`, `${table}transcript_events (`],
    [`${table}context_engine_turn_outbox (`, `${table}cache_entries (`],
    [`${table}memory_entry_origins (`, `${table}memory_embedding_cache (`],
    [
      "CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_entry_valid_pending\n",
      `${table}session_windows (`,
    ],
    [
      "-- Older same-version writers preserve the envelope",
      "CREATE INDEX IF NOT EXISTS idx_agent_session_conversations_conversation",
    ],
    [
      "-- Canonical cold-tier owner for reclaimed transcript generations.",
      `${table}transcript_rewrite_watermarks (`,
    ],
  ] as const) {
    sql = omitFrozenSqlSection(sql, start, end);
  }
  return sql;
}

/** Exact schema bytes from v2026.7.2-beta.4, the first tagged agent schema v14. */
export function historicalV14AgentSchemaSql(): string {
  let sql = historicalV16AgentSchemaSql();
  sql = omitFrozenSqlSection(
    sql,
    "\nCREATE TABLE IF NOT EXISTS session_suggestions (",
    "CREATE TABLE IF NOT EXISTS board_tabs (",
  );
  sql = omitFrozenSqlSection(
    sql,
    "CREATE TABLE IF NOT EXISTS memory_index_chunk_recall_metadata (",
    "CREATE TABLE IF NOT EXISTS memory_embedding_cache (",
  );
  return omitFrozenSqlSection(
    sql,
    "CREATE TABLE IF NOT EXISTS standing_intents (",
    "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
  );
}
