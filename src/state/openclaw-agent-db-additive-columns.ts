import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";

type BareNullableSqliteDatatype = "INTEGER" | "TEXT";

type LazyAdditiveAgentColumnDefinition = {
  columnName: string;
  dataType: BareNullableSqliteDatatype;
  tableName: "session_nodes" | "session_key_contract";
};

// Session responsibility is feature-local and remains absent until the first
// explicit assignment. Bare nullable declarations keep older readers safe.
export const SESSION_OWNER_COLUMN_DEFINITIONS = [
  { columnName: "owner_actor_type", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_actor_id", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_by_type", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_by_id", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_at", dataType: "INTEGER", tableName: "session_nodes" },
] as const satisfies readonly LazyAdditiveAgentColumnDefinition[];

export const LEGACY_ACP_MIGRATION_COLUMN_DEFINITION = {
  columnName: "legacy_acp_migration_json",
  dataType: "TEXT",
  tableName: "session_nodes",
} as const satisfies LazyAdditiveAgentColumnDefinition;

export const CANONICAL_READY_COLUMN_DEFINITION = {
  columnName: "canonical_ready",
  dataType: "TEXT",
  tableName: "session_key_contract",
} as const satisfies LazyAdditiveAgentColumnDefinition;

export const FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS = [
  ...SESSION_OWNER_COLUMN_DEFINITIONS,
  LEGACY_ACP_MIGRATION_COLUMN_DEFINITION,
  CANONICAL_READY_COLUMN_DEFINITION,
] as const satisfies readonly LazyAdditiveAgentColumnDefinition[];

// Startup installs these on every existing table before exposing session readers.
// First-use columns above remain feature-local and are not admission prerequisites.
export const STARTUP_ADDITIVE_AGENT_COLUMN_DEFINITIONS = [
  { tableName: "session_pending_inputs", columnName: "consumed_event_id", dataType: "TEXT" },
  {
    tableName: "session_transcript_active_events",
    columnName: "context_eligible",
    dataType: "INTEGER",
  },
  { tableName: "session_nodes", columnName: "project_id", dataType: "TEXT" },
  { tableName: "session_windows", columnName: "row_transcript_json", dataType: "TEXT" },
  { tableName: "session_windows", columnName: "row_transcript_updated_at", dataType: "INTEGER" },
  { tableName: "session_conversations", columnName: "route_context_json", dataType: "TEXT" },
] as const;

/** Missing feature-local tables stay absent; existing tables must satisfy this build's readers. */
export function hasPendingAgentStartupColumns(
  tableSql: ReadonlyMap<string, string | null>,
): boolean {
  const columns = new Map<string, ReadonlyMap<string, string>>();
  return STARTUP_ADDITIVE_AGENT_COLUMN_DEFINITIONS.some(({ tableName, columnName }) => {
    if (!tableSql.has(tableName)) {
      return false;
    }
    const sql = tableSql.get(tableName);
    if (!sql) {
      return true;
    }
    let parsed = columns.get(tableName);
    if (!parsed) {
      parsed = parseSqliteTableDefinition(sql, tableName).columns;
      columns.set(tableName, parsed);
    }
    return !parsed.has(columnName);
  });
}
