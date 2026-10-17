import type { DatabaseSync } from "node:sqlite";
import { hasLegacyMemoryRecallMetadataColumns } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
  collectSqliteSchemaIssues,
  getCanonicalSqliteNamedIndexNames,
  getCanonicalSqliteTableNames,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  legacySqliteSchemaIssueMessages,
  SqliteSchemaMismatchError,
  throwSqliteSchemaMismatches,
} from "../infra/sqlite-schema-issues.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_V14_BOARD_SCHEMA_SQL,
  ensureOpenClawAgentBoardSchemaInTransaction,
} from "./openclaw-agent-board-schema.js";
import { ensureLegacySessionEntryValidityTriggers } from "./openclaw-agent-canonical-validation-migration.js";
import { hasPendingAgentStartupColumns } from "./openclaw-agent-db-additive-columns.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  readExistingAgentSchemaMeta,
  assertExistingAgentSchemaOwner,
  assertCurrentAgentSchemaMetadata,
} from "./openclaw-agent-db-schema-read.js";
import {
  ensureSessionAdditiveColumns,
  readSqliteTableColumns,
  ensureSessionEntryValidityProjection,
} from "./openclaw-agent-db-session-migrations.js";
import { LEGACY_PARTICIPANT_OPTIONAL_COLUMNS } from "./openclaw-agent-participants-migration.js";
import {
  ensureOpenClawAgentProgressCardSchemaInTransaction,
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
} from "./openclaw-agent-progress-card-schema.js";
import { RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL } from "./openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
} from "./openclaw-agent-session-sharing-schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export {
  assertSupportedAgentSchemaVersion,
  assertCurrentAgentSchemaMetadata,
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
  assertExistingAgentSchemaOwner,
} from "./openclaw-agent-db-schema-read.js";

export { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";

export function migratedSessionColumn(
  columns: ReadonlySet<string>,
  columnName: string,
  fallback: string,
): string {
  return columns.has(columnName) ? columnName : fallback;
}

function hasRetiredAgentStateLeaseSchema(database: DatabaseSync): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'state_leases'").get(),
  );
}

export function assertOpenClawAgentSchemaContains(
  database: DatabaseSync,
  pathname: string,
  schemaSql: string,
  participantSchema: "current" | "legacy" = "current",
  allowStartupIndexRepair = false,
  readTable?: SqliteTableContractReader,
): boolean {
  const compatibility = {
    ...AGENT_SCHEMA_COMPATIBILITY,
    allowedMissingTables: [
      ...AGENT_SCHEMA_COMPATIBILITY.allowedMissingTables,
      // Legacy migration preflight precedes creation of the required v20 table.
      ...(participantSchema === "legacy" ? ["session_transcript_cold_archives"] : []),
    ],
    allowedMissingColumns: [
      ...AGENT_SCHEMA_COMPATIBILITY.allowedMissingColumns,
      ...(participantSchema === "legacy" ? LEGACY_PARTICIPANT_OPTIONAL_COLUMNS : []),
    ],
  };
  if (!allowStartupIndexRepair) {
    assertSqliteSchemaContains(database, pathname, schemaSql, compatibility, readTable);
    return false;
  }
  // Admission is read-only; the writable schema owner rebuilds these projections
  // before session startup completes. Constraints and canonical data stay strict.
  const repairableIndexes = new Set(getCanonicalSqliteNamedIndexNames(schemaSql));
  const issues = collectSqliteSchemaIssues(database, schemaSql, compatibility, readTable);
  if (
    issues.some(
      (issue) =>
        issue.code !== "missing-or-drifted-index" || !repairableIndexes.has(issue.objectName),
    )
  ) {
    throwSqliteSchemaMismatches(pathname, legacySqliteSchemaIssueMessages(issues));
  }
  return issues.length > 0;
}

export function assertOpenClawAgentCurrentRuntimeSchema(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
  readTable?: SqliteTableContractReader,
): void {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  assertCurrentAgentSchemaMetadata(metadata, agentId, options.pathname);
  if (hasRetiredAgentStateLeaseSchema(database)) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} retains retired state_leases storage; run openclaw doctor --fix before using it.`,
    );
  }
  assertOpenClawAgentSchemaContains(
    database,
    options.pathname,
    OPENCLAW_AGENT_SCHEMA_SQL,
    "current",
    false,
    readTable,
  );
}

function hasAnyCanonicalTable(database: DatabaseSync, schemaSql: string): boolean {
  const tableNames = getCanonicalSqliteTableNames(schemaSql);
  const placeholders = tableNames.map(() => "?").join(", ");
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM main.sqlite_schema
         WHERE type = 'table' AND name IN (${placeholders})
         LIMIT 1`,
      )
      .get(...tableNames),
  );
}

function repairAndAssertAgentSchemaGroup(
  database: DatabaseSync,
  pathname: string,
  schemaSql: string,
): void {
  repairCanonicalSqliteIndexes(database, pathname, schemaSql, {
    verifyPhysicalIntegrity: false,
  });
  assertOpenClawAgentSchemaContains(database, pathname, schemaSql, "legacy");
}

/** Ensure the additive session-key contract table inside the caller's transaction. */
export function ensureSessionKeyContractSchemaInTransaction(db: DatabaseSync): void {
  if (
    tableExists(db, "session_key_contract") &&
    db.prepare("SELECT 1 FROM session_key_contract WHERE id = 1").get()
  ) {
    return;
  }
  db.exec(
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_key_contract", {
      endMarker: "CREATE TABLE IF NOT EXISTS session_windows (",
      includeEndMarker: false,
      errorMessage: "OpenClaw agent session-key contract schema markers are missing.",
    }),
  ); // sqlite-allow-raw -- Idempotent additive lazy ensure.
}

export function ensureSessionReactionsSchemaInTransaction(db: DatabaseSync): void {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (
    schema?.tables.has("session_reactions") &&
    schema.indexes.has("idx_agent_session_reactions_message")
  ) {
    return;
  }
  db.exec(
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_reactions", {
      endMarker: "CREATE TABLE IF NOT EXISTS board_tabs (",
      includeEndMarker: false,
      errorMessage: "OpenClaw agent session-reactions schema markers are missing.",
    }),
  ); // sqlite-allow-raw -- Canonical additive DDL at database admission.
}

export function repairAndAssertOpenClawAgentV14SchemaForMigration(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== 14) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; expected 14 before migrating it.`,
    );
  }
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== 14) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match 14; repair the ownership metadata before migrating it.`,
    );
  }

  ensureSessionAdditiveColumns(database);
  ensureSessionEntryValidityProjection(database);
  ensureLegacySessionEntryValidityTriggers(database);
  ensureSessionKeyContractSchemaInTransaction(database);

  // v14 always owned the core schema. Board and collaboration groups were
  // lazy, but a partially present group still has to be complete and canonical.
  // Keep this preflight before full CREATE IF NOT EXISTS convergence: otherwise
  // a missing stable v14 table could be recreated empty and hide data loss.
  repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_CORE_SCHEMA_SQL);
  if (hasAnyCanonicalTable(database, AGENT_V14_SESSION_SHARING_SCHEMA_SQL)) {
    repairAndAssertAgentSchemaGroup(
      database,
      options.pathname,
      AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
    );
  }
  if (hasAnyCanonicalTable(database, AGENT_V14_ADDITIVE_SCHEMA_SQL)) {
    repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_ADDITIVE_SCHEMA_SQL);
  }
  if (hasAnyCanonicalTable(database, AGENT_V14_BOARD_SCHEMA_SQL)) {
    assertSqliteSchemaTablesPresent(database, options.pathname, AGENT_V14_BOARD_SCHEMA_SQL);
    ensureOpenClawAgentBoardSchemaInTransaction(database);
    repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_BOARD_SCHEMA_SQL);
  }
  if (hasAnyCanonicalTable(database, AGENT_PROGRESS_CARD_SCHEMA_SQL)) {
    assertSqliteSchemaTablesPresent(database, options.pathname, AGENT_PROGRESS_CARD_SCHEMA_SQL);
    ensureOpenClawAgentProgressCardSchemaInTransaction(database);
    repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_PROGRESS_CARD_SCHEMA_SQL);
  }
}

export function migrateRetiredAgentStateLeaseSchema(
  db: DatabaseSync,
  pathname: string,
  targetVersion: number,
): void {
  if (targetVersion < 17 || !hasRetiredAgentStateLeaseSchema(db)) {
    return;
  }
  // The 2026-08-10 tenant audit found no agent-DB lease writers after #121113;
  // #121615 removed the unreachable routing arm, so v17 retires this table.
  assertSqliteSchemaContains(db, pathname, RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL);
  // DROP TABLE also removes the retired indexes and sqlite_stat rows atomically.
  db.exec("DROP TABLE state_leases;");
}

export function assertAgentSchemaVersion(
  db: DatabaseSync,
  options: { agentId: string; pathname: string; version: number },
  schemaSql: string,
): void {
  const metadata = readExistingAgentSchemaMeta(db);
  assertExistingAgentSchemaOwner(metadata, options.agentId, options.pathname);
  const userVersion = readSqliteUserVersion(db);
  if (userVersion !== options.version || metadata?.schemaVersion !== options.version) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} did not converge on schema version ${options.version}.`,
    );
  }
  assertOpenClawAgentSchemaContains(
    db,
    options.pathname,
    schemaSql,
    options.version < 18 ? "legacy" : "current",
  );
}

export function finishAgentSchemaMigration(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion: number,
  schemaSql: string,
  requiresMaintenance: boolean,
  assertMigration: () => void,
  integrityTables?: readonly string[],
): void {
  db.exec(`PRAGMA user_version = ${targetVersion};`);
  persistAgentSchemaMetadata(db, agentId, targetVersion);
  assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
  for (const table of integrityTables ?? []) {
    if (tableExists(db, table)) {
      assertSqliteTableIntegrity(db, pathname, table);
    }
  }
  if (requiresMaintenance && db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error(`Agent schema migration failed foreign key validation for ${pathname}.`);
  }
  assertMigration();
}

function hasLegacyMemoryChunkProvenanceTrigger(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
      )
      .get(),
  );
}

export function hasPendingMemoryChunkMetadataMigration(db: DatabaseSync): boolean {
  return hasLegacyMemoryRecallMetadataColumns(db) || hasLegacyMemoryChunkProvenanceTrigger(db);
}

function hasPendingSessionKeyContractSchemaMigration(db: DatabaseSync): boolean {
  const sessionNodeColumns = readSqliteTableColumns(db, "session_nodes");
  if (!sessionNodeColumns) {
    return false;
  }
  const hasContractTable = tableExists(db, "session_key_contract");
  return !sessionNodeColumns.has("entry_valid") || !hasContractTable;
}

export function hasPendingCurrentVersionAgentDatabaseMigration(database: DatabaseSync): boolean {
  return (
    !tableExists(database, "session_reactions") ||
    hasPendingMemoryChunkMetadataMigration(database) ||
    hasPendingSessionKeyContractSchemaMigration(database) ||
    hasRetiredAgentStateLeaseSchema(database) ||
    hasPendingAgentStartupColumns(
      (getAdmittedSqliteSchemaFacts(database) ?? captureSqliteSchemaFacts(database)).tableSql,
    )
  );
}
