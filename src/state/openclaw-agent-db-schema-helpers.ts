import type { DatabaseSync } from "node:sqlite";
import { hasLegacyMemoryRecallMetadataColumns } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
  collectSqliteSchemaIssues,
  getCanonicalSqliteNamedIndexContracts,
  getCanonicalSqliteTableNames,
} from "../infra/sqlite-schema-contract.js";
import {
  legacySqliteSchemaIssueMessages,
  throwSqliteSchemaMismatches,
} from "../infra/sqlite-schema-issues.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_V14_BOARD_SCHEMA_SQL,
  ensureOpenClawAgentBoardSchemaInTransaction,
} from "./openclaw-agent-board-schema.js";
import { withoutCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import {
  CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  readExistingAgentSchemaMeta,
  assertExistingAgentSchemaOwner,
} from "./openclaw-agent-db-schema-read.js";
import {
  ensureSessionAdditiveColumns,
  readSqliteTableColumns,
  hasPendingSessionConversationRouteContextColumn,
  hasPendingSessionProjectColumn,
  hasPendingSessionTranscriptContextEligibilityColumn,
  ensureSessionEntryValidityProjection,
} from "./openclaw-agent-db-session-migrations.js";
import {
  LEGACY_PARTICIPANT_OPTIONAL_COLUMNS,
  withLegacySessionParticipantsSchema,
} from "./openclaw-agent-participants-migration.js";
import { hasPendingInputConsumptionColumnMigration } from "./openclaw-agent-pending-inputs-schema.js";
import {
  ensureOpenClawAgentProgressCardSchemaInTransaction,
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
} from "./openclaw-agent-progress-card-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
} from "./openclaw-agent-session-sharing-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export {
  assertSupportedAgentSchemaVersion,
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
  assertExistingAgentSchemaOwner,
} from "./openclaw-agent-db-schema-read.js";

/** Compare historical migration targets against only the representation they support. */
export function getOpenClawAgentMigrationSchema(targetVersion: number): string {
  const targetSchemaSql =
    targetVersion < AGENT_STORAGE_SCHEMA_VERSION
      ? withLegacyAgentStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL, targetVersion)
      : OPENCLAW_AGENT_SCHEMA_SQL;
  return targetVersion < 18
    ? withLegacySessionParticipantsSchema(targetSchemaSql)
    : targetVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
      ? withoutCanonicalSessionValidationSchema(targetSchemaSql)
      : targetSchemaSql;
}

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
): void {
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
    assertSqliteSchemaContains(database, pathname, schemaSql, compatibility);
    return;
  }
  // Admission is read-only; the writable schema owner rebuilds these projections
  // before session startup completes. Constraints and canonical data stay strict.
  const repairableIndexes = new Set(
    getCanonicalSqliteNamedIndexContracts(schemaSql).map((index) => index.name),
  );
  const issues = collectSqliteSchemaIssues(database, schemaSql, compatibility);
  if (
    issues.some(
      (issue) =>
        issue.code !== "missing-or-drifted-index" || !repairableIndexes.has(issue.objectName),
    )
  ) {
    throwSqliteSchemaMismatches(pathname, legacySqliteSchemaIssueMessages(issues));
  }
}

export function assertOpenClawAgentCurrentRuntimeSchema(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before using it.`,
    );
  }
  if (hasRetiredAgentStateLeaseSchema(database)) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} retains retired state_leases storage; run openclaw doctor --fix before using it.`,
    );
  }
  assertOpenClawAgentSchemaContains(database, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
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
  db.exec(
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_key_contract", {
      endMarker: "CREATE TABLE IF NOT EXISTS session_windows (",
      includeEndMarker: false,
      errorMessage: "OpenClaw agent session-key contract schema markers are missing.",
    }),
  ); // sqlite-allow-raw -- Idempotent additive lazy ensure.
}

export function repairAndAssertOpenClawAgentV14SchemaForMigration(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== 14) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; expected 14 before migrating it.`,
    );
  }
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== 14) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match 14; repair the ownership metadata before migrating it.`,
    );
  }

  ensureSessionAdditiveColumns(database);
  ensureSessionEntryValidityProjection(database);
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

const RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL = `
CREATE TABLE state_leases (
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
`;

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
    throw new Error(
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
    hasPendingMemoryChunkMetadataMigration(database) ||
    hasPendingSessionKeyContractSchemaMigration(database) ||
    hasRetiredAgentStateLeaseSchema(database) ||
    hasPendingSessionConversationRouteContextColumn(database) ||
    hasPendingSessionTranscriptContextEligibilityColumn(database) ||
    hasPendingInputConsumptionColumnMigration(database) ||
    hasPendingSessionProjectColumn(database)
  );
}
