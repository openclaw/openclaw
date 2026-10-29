import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

export const SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION = 24;

export function sessionEntrySnapshotsSchemaSql(schema: string): string {
  return extractSqliteTableSchema(schema, "session_entry_snapshots", {
    endMarker: "CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_updated_at",
    includeEndMarker: false,
  });
}

/** Historical admission must validate the representation its reader actually understood. */
export function withoutSessionEntrySnapshotsSchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_entry_snapshots (")) {
    return schema;
  }
  return schema
    .replace("  snapshot_revision INTEGER NOT NULL DEFAULT 0,\n", "")
    .replace(sessionEntrySnapshotsSchemaSql(schema), "");
}
