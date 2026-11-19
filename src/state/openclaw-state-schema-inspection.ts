import type { DatabaseSync } from "node:sqlite";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  type SqliteSchemaIssue,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  SqliteSchemaMismatchError,
  throwSqliteSchemaMismatches,
} from "../infra/sqlite-schema-issues.js";
import { extractSqliteTableSchema, normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { hasLegacyCronRunLogs } from "../infra/state-legacy-cron-presence.js";
import {
  adoptPeerPublishedStateSchemaVersion,
  getStateRuntimeSchemaAdmission,
  getStateSchemaVersionAdmission,
} from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  classifySqliteTableReadError,
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
  type StateSchemaVersionFacts,
} from "./openclaw-state-db-schema-version.js";
import {
  findMissingLazyStateStartupColumn,
  isOpenClawStateFirstUseSchemaIssue,
  isOpenClawStateStartupRepairableSchemaIssue,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  STATE_RUNTIME_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const AUDIT_EVENT_STATE_SCHEMA_VERSION = 2;
const CANONICAL_AUDIT_TABLES = ["audit_events", "audit_identity_keys"].map((name) => ({
  name,
  sql: normalizeSchemaSql(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, name)),
}));

const AUDIT_EVENT_LEGACY_COLUMNS = [
  "sequence",
  "event_id",
  "source_id",
  "source_sequence",
  "occurred_at",
  "kind",
  "action",
  "status",
  "error_code",
  "actor_type",
  "actor_id",
  "agent_id",
  "session_key",
  "session_id",
  "run_id",
  "tool_call_id",
  "tool_name",
] as const;

export const AUDIT_EVENT_MIGRATED_COLUMNS = AUDIT_EVENT_LEGACY_COLUMNS.flatMap((column) =>
  column === "source_id" ? [column, "schema_version"] : [column],
);

const AUDIT_EVENT_V2_COLUMNS = [
  ...AUDIT_EVENT_MIGRATED_COLUMNS,
  "direction",
  "channel",
  "conversation_kind",
  "message_outcome",
  "reason_code",
  "delivery_kind",
  "failure_stage",
  "duration_ms",
  "result_count",
  "account_ref",
  "conversation_ref",
  "message_ref",
  "target_ref",
] as const;

function tableHasCanonicalColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  primaryKey: string,
  required: readonly string[],
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const keys = columns.filter((column) => Number(column.pk ?? 0) > 0);
  return (
    columns.length === expected.length &&
    columns.every((column, index) => column.name === expected[index]) &&
    keys.length === 1 &&
    keys[0]?.name === primaryKey &&
    required.every((name) =>
      columns.some((column) => column.name === name && Number(column.notnull ?? 0) === 1),
    )
  );
}

function tableSql(db: DatabaseSync, tableName: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return typeof row?.sql === "string" ? row.sql : undefined;
}

function tableHasUniqueColumns(
  db: DatabaseSync,
  tableName: string,
  columnNames: readonly string[],
): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all();
  return columnNames.every((columnName) =>
    indexes.some((index) => {
      if (Number(index.unique ?? 0) !== 1 || typeof index.name !== "string") {
        return false;
      }
      const escaped = index.name.replaceAll("'", "''");
      const columns = db.prepare(`PRAGMA index_info('${escaped}')`).all();
      return columns.length === 1 && columns[0]?.name === columnName;
    }),
  );
}

function hasCanonicalAuditEventTable(
  db: DatabaseSync,
  expectedColumns: readonly string[],
  requiredColumns: readonly string[],
): boolean {
  const sql = tableSql(db, "audit_events")?.toLowerCase();
  return (
    tableHasCanonicalColumns(db, "audit_events", expectedColumns, "sequence", requiredColumns) &&
    typeof sql === "string" &&
    /\bsequence\s+integer\s+primary\s+key\s+autoincrement\b/.test(sql) &&
    tableHasUniqueColumns(db, "audit_events", ["event_id", "source_id"])
  );
}

function hasCanonicalAuditIdentityKeyTable(db: DatabaseSync): boolean {
  if (!tableExists(db, "audit_identity_keys")) {
    return false;
  }
  const sql = tableSql(db, "audit_identity_keys")?.toLowerCase();
  return (
    tableHasCanonicalColumns(
      db,
      "audit_identity_keys",
      ["id", "key_id", "key", "created_at"],
      "id",
      ["id", "key_id", "key", "created_at"],
    ) &&
    typeof sql === "string" &&
    /\bcheck\s*\(\s*id\s*=\s*1\s*\)/.test(sql)
  );
}

export function hasCanonicalAuditEventsSchema(db: DatabaseSync): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  // Exact CREATE definitions include the required primary keys and UNIQUE constraints.
  if (
    schema &&
    CANONICAL_AUDIT_TABLES.every(
      ({ name, sql }) => normalizeSchemaSql(schema.tableSql.get(name) ?? null) === sql,
    )
  ) {
    return true;
  }
  if (!tableExists(db, "audit_events")) {
    return (
      readSqliteUserVersion(db) < AUDIT_EVENT_STATE_SCHEMA_VERSION &&
      !tableExists(db, "audit_identity_keys")
    );
  }
  return (
    hasCanonicalAuditEventTable(db, AUDIT_EVENT_V2_COLUMNS, [
      "event_id",
      "source_id",
      "schema_version",
      "source_sequence",
      "occurred_at",
      "kind",
      "action",
      "status",
      "actor_type",
      "actor_id",
    ]) && hasCanonicalAuditIdentityKeyTable(db)
  );
}

export function canRepairLegacyAuditEventsSchema(db: DatabaseSync): boolean {
  // Our own transactional repair cannot leave audit_events_migration_new
  // behind, so an existing one is foreign data; fail closed rather than let
  // repair silently drop it.
  if (
    !tableExists(db, "audit_events") ||
    tableExists(db, "audit_events_migration_new") ||
    tableHasColumn(db, "audit_events", "schema_version")
  ) {
    return false;
  }
  const identityTableIsSafe =
    !tableExists(db, "audit_identity_keys") || hasCanonicalAuditIdentityKeyTable(db);
  return (
    identityTableIsSafe &&
    hasCanonicalAuditEventTable(db, AUDIT_EVENT_LEGACY_COLUMNS, [
      "event_id",
      "source_id",
      "source_sequence",
      "occurred_at",
      "kind",
      "action",
      "status",
      "actor_type",
      "actor_id",
      "agent_id",
      "run_id",
    ])
  );
}

export function readOperatorApprovalTableSql(db: DatabaseSync): string | undefined {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return schema.tableSql.get("operator_approvals") ?? undefined;
  }
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_approvals'")
    .get();
  return typeof row?.sql === "string" ? row.sql : undefined;
}

export function hasCanonicalOperatorApprovalKinds(db: DatabaseSync): boolean {
  if (!tableExists(db, "operator_approvals")) {
    return true;
  }
  return /kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(\s*'exec'\s*,\s*'plugin'\s*,\s*'system-agent'\s*\)\s*\)/.test(
    readOperatorApprovalTableSql(db)?.toLowerCase() ?? "",
  );
}

export function assertCanonicalOperatorApprovalKinds(db: DatabaseSync, pathname: string): void {
  if (!hasCanonicalOperatorApprovalKinds(db)) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${pathname} has a legacy operator approval schema; run openclaw doctor --fix to migrate it.`,
    );
  }
}

/** Require canonical shared-state ownership without requiring the latest schema. */
export function assertOpenClawStateDatabaseOwner(
  database: EngineConnection,
  options: { pathname: string },
): { schema_version?: unknown } {
  const admitted = getStateSchemaVersionAdmission(database);
  if (admitted && getStateRuntimeSchemaAdmission(database)) {
    return { schema_version: admitted.userVersion };
  }
  const hasMetadataTable = tableExists(database, "schema_meta");
  let metadata;
  try {
    metadata = hasMetadataTable
      ? database
          .prepare(
            "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
          )
          .get()
      : undefined;
  } catch (error) {
    throw classifySqliteTableReadError(
      database,
      "schema_meta",
      ["meta_key", "role", "schema_version"],
      error,
    );
  }
  if (metadata?.role !== "global") {
    const role = typeof metadata?.role === "string" ? metadata.role : "missing";
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${options.pathname} has schema role ${role}; expected global. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  return metadata;
}

/** Require the canonical shared-state owner and schema before offline file maintenance. */
export function assertOpenClawStateDatabaseForMaintenance(
  database: EngineConnection,
  options: { pathname: string; schemaVersions?: StateSchemaVersionFacts },
  readTable?: SqliteTableContractReader,
): void {
  if (isPostgresSqlConnection(database)) {
    requireNativeDatabaseFile("postgres", "repair");
  }
  const userVersion = assertSupportedStateSchemaVersion(
    database,
    options.pathname,
    options.schemaVersions,
  );
  const contentVersion =
    options.schemaVersions?.contentVersion ?? readStateSchemaContentVersion(database);
  if (contentVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }

  const metadata = assertOpenClawStateDatabaseOwner(database, options);
  if (
    metadata?.schema_version !== userVersion &&
    !adoptPeerPublishedStateSchemaVersion(database, metadata)
  ) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }
  assertSqliteSchemaContains(
    database,
    options.pathname,
    OPENCLAW_STATE_SCHEMA_SQL,
    OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
    readTable,
  );
}

export function assertCanonicalAgentDatabasesPrimaryKey(db: DatabaseSync, pathname: string): void {
  if (!tableExists(db, "agent_databases")) {
    return;
  }
  const primaryKey = tablePrimaryKeyColumns(db, "agent_databases");
  if (primaryKey.length !== 2 || primaryKey[0] !== "agent_id" || primaryKey[1] !== "path") {
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${pathname} has an unsupported agent database registry schema. Upgrades from pre-July-2026 state are no longer migrated; restore a backup produced by a July 2026 or newer release before retrying.`,
    );
  }
}

export function assertCanonicalStateSchemaShape(db: DatabaseSync, pathname: string): void {
  assertCanonicalOperatorApprovalKinds(db, pathname);
  assertCanonicalAgentDatabasesPrimaryKey(db, pathname);
  if (!hasCanonicalAuditEventsSchema(db)) {
    if (canRepairLegacyAuditEventsSchema(db)) {
      throw new OpenClawStateDatabaseSchemaMigrationRequiredError("audit-events-v2", pathname);
    }
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${pathname} has a noncanonical audit event schema that cannot be repaired automatically; restore the canonical audit_events shape before retrying.`,
    );
  }
}

export function assertCurrentStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  readTable: SqliteTableContractReader = createSqliteTableContractReader(database),
): void {
  const missing = findMissingLazyStateStartupColumn(readTable);
  if (missing) {
    throwSqliteSchemaMismatches(pathname, [
      "missing column " + missing.tableName + "." + missing.columnName,
    ]);
  }
  assertCanonicalStateSchemaShape(database, pathname);
  assertOpenClawStateDatabaseForMaintenance(database, { pathname }, readTable);
  assertSqliteSchemaContains(
    database,
    pathname,
    OPENCLAW_STATE_SCHEMA_SQL,
    STATE_RUNTIME_SCHEMA_COMPATIBILITY,
    readTable,
  );
}

/** Catalog presence is enough to refuse retired history without reading or rewriting its rows. */
export function assertNoLegacyStateRuntimeRepair(database: DatabaseSync, pathname: string): void {
  if (hasLegacyCronRunLogs(database)) {
    throw new OpenClawStateDatabaseSchemaMigrationRequiredError("legacy-cron-run-logs", pathname);
  }
}

function deduplicateSchemaIssues(issues: readonly SqliteSchemaIssue[]): SqliteSchemaIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [`${issue.code}\0${issue.objectName}`, issue] as const),
    ).values(),
  ];
}

export function inspectCurrentStateStartupSchema(
  database: DatabaseSync,
  databasePath: string,
  foundVersion: number,
) {
  const metadata = assertOpenClawStateDatabaseOwner(database, { pathname: databasePath });
  if (metadata?.schema_version !== foundVersion) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${databasePath} metadata schema version ${typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid"} does not match ${foundVersion}.`,
    );
  }
  // Both policies inspect the same private or immutable snapshot; later opens read fresh facts.
  const readTable = createSqliteTableContractReader(database);
  const issues = deduplicateSchemaIssues([
    ...collectSqliteSchemaIssues(
      database,
      OPENCLAW_STATE_SCHEMA_SQL,
      OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
      readTable,
    ),
    ...collectSqliteSchemaIssues(
      database,
      OPENCLAW_STATE_SCHEMA_SQL,
      STATE_RUNTIME_SCHEMA_COMPATIBILITY,
      readTable,
    ),
  ]);
  return {
    blockingIssues: issues.filter(
      (issue) =>
        !isOpenClawStateStartupRepairableSchemaIssue(issue) &&
        !isOpenClawStateFirstUseSchemaIssue(issue),
    ),
    startupRepairableIssues: issues.filter(isOpenClawStateStartupRepairableSchemaIssue),
  };
}
