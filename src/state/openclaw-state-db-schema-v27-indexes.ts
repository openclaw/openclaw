import type { EngineConnection } from "../infra/sql-connection.js";

/** Exact historical indexes used by source admission and the PostgreSQL generator. */
export function withLegacyStateWriteIndexes(schema: string): string {
  return `${schema.replace(
    /ON state_leases\(owner\);/u,
    "ON state_leases(owner, updated_at DESC);",
  )}
CREATE INDEX IF NOT EXISTS idx_skill_usage_key
  ON skill_usage(skill_key, skill_file);
CREATE INDEX IF NOT EXISTS idx_acp_replay_events_session_seq
  ON acp_replay_events(session_id, seq);
`;
}

// Canonical schema installation creates the narrowed lease-owner index in this transaction.
export const STATE_WRITE_INDEX_RETIREMENT_V27_SQL = `
  DROP INDEX IF EXISTS idx_acp_replay_events_session_seq;
  DROP INDEX IF EXISTS idx_skill_usage_key;
  DROP INDEX IF EXISTS idx_state_leases_owner;
`;

export function migrateStateWriteIndexesV27(
  db: EngineConnection,
  previousVersion: number,
): boolean {
  if (previousVersion >= 27) {
    return false;
  }
  // sqlite-allow-raw -- Exact-name index changes belong to the versioned schema owner.
  db.exec(STATE_WRITE_INDEX_RETIREMENT_V27_SQL);
  return true;
}
