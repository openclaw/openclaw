type BareNullableSqliteDatatype = "INTEGER" | "TEXT";

type LazyAdditiveAgentColumnDefinition = {
  columnName: string;
  dataType: BareNullableSqliteDatatype;
  tableName: "session_nodes";
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

export const FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS = [
  ...SESSION_OWNER_COLUMN_DEFINITIONS,
  LEGACY_ACP_MIGRATION_COLUMN_DEFINITION,
] as const satisfies readonly LazyAdditiveAgentColumnDefinition[];
