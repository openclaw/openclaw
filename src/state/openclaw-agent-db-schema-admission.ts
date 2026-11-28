import type { DatabaseSync } from "node:sqlite";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import { verifyAndRepairCanonicalSqliteIndexSteps } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import type { SqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  isSqliteSchemaAdmissionCold,
} from "../infra/sqlite-schema-facts.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { admitAgentDatabaseRuntimeStructure } from "./agent-database-startup-integrity.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  assertOpenClawAgentCurrentRuntimeSchema,
  hasPendingCurrentVersionAgentDatabaseMigration,
} from "./openclaw-agent-db-schema-helpers.js";
import { hasAgentDatabaseApplicationSchema } from "./openclaw-agent-db-schema-read.js";
import { setOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

/** Publish completed canonical schema admission from the still-open maintenance handle. */
export function admitOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: { agentId: string; path: string },
): DatabaseSync | undefined {
  // Quick migration coverage cannot publish full-integrity verification.
  if (
    db.location() &&
    readSqliteDatabaseIntegrityVerification(db) &&
    (isSqliteSchemaAdmissionCold(db) || getAdmittedSqliteSchemaFacts(db))
  ) {
    admitSqliteSchema(db);
    assertCanonicalSessionValidationSchema(db);
    registerOpenClawAgentDatabaseIdentity(db);
    setOpenClawAgentDatabaseValidation({ db, ...options });
    return db;
  }
  return undefined;
}

export function* agentDatabaseIntegrityBeforeMutationSteps(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
  {
    runtimeAdmission = false,
    diagnostics,
    verification,
    reuseRuntimeIntegrity = false,
    admittedSchema = false,
    integrityCheck,
    integrityTables,
  }: {
    runtimeAdmission?: boolean;
    diagnostics?: SqliteIntegrityDiagnostics;
    verification?: { verifiedAt: number };
    reuseRuntimeIntegrity?: boolean;
    admittedSchema?: boolean;
    integrityCheck?: "quick" | "full";
    integrityTables?: readonly string[];
  } = {},
): SqliteIntegrityOperation<boolean> {
  // Bounded runtime admission is not the verification required by startup or maintenance.
  const reuseAdmission = runtimeAdmission && reuseRuntimeIntegrity;
  if (reuseAdmission && admittedSchema) {
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "cached";
    }
    return false;
  }
  setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
  const userVersion =
    getAdmittedSqliteSchemaFacts(database)?.userVersion ?? readSqliteUserVersion(database);
  const hasApplicationSchema = userVersion === 0 && hasAgentDatabaseApplicationSchema(database);
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_AGENT_SCHEMA_VERSION);
  if (migrationPending) {
    agentDbLog.info("agent database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  }
  const hasPendingCurrentVersionMigration =
    userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    hasPendingCurrentVersionAgentDatabaseMigration(database);
  const integrity = resolveSchemaMigrationIntegrityCheck(
    {
      kind: "agent",
      foundVersion: userVersion,
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    integrityCheck,
  );
  const startedAt = performance.now();
  if (userVersion >= OPENCLAW_AGENT_SCHEMA_VERSION && !hasPendingCurrentVersionMigration) {
    const boundedIndexes =
      runtimeAdmission && !verification && !reuseAdmission && integrityCheck !== "full"
        ? admitAgentDatabaseRuntimeStructure(database, pathname, agentId, diagnostics)
        : undefined;
    const reuseIntegrity =
      reuseAdmission ||
      (verification !== undefined && !migrationPending && !hasPendingCurrentVersionMigration);
    const validateSchema = (readTable?: SqliteTableContractReader) =>
      assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname }, readTable);
    const rebuiltIndexes =
      boundedIndexes ??
      (yield* verifyAndRepairCanonicalSqliteIndexSteps(
        database,
        pathname,
        OPENCLAW_AGENT_SCHEMA_SQL,
        {
          allowMissingColumns: true,
          validateAfterRepair: validateSchema,
          validateUnchanged: validateSchema,
          diagnostics,
          reuseIntegrity,
          // Current-schema callbacks do not repeat historical migration table coverage.
          integrity: integrityCheck
            ? { ...integrity, tables: integrityTables ?? integrity.tables }
            : undefined,
        },
      ));
    if (rebuiltIndexes.length > 0) {
      agentDbLog.warn(
        `Rebuilt canonical agent SQLite indexes for ${agentId} (${pathname}): ${rebuiltIndexes.join(", ")}`,
        {
          agentId,
          path: pathname,
          indexes: rebuiltIndexes,
          elapsedMs: Math.floor(performance.now() - startedAt),
        },
      );
    }
  } else if (
    userVersion === 0 &&
    !hasApplicationSchema &&
    database // sqlite-allow-raw -- Physical empty-file admission precedes application ownership.
      .prepare("PRAGMA page_count")
      .get()?.page_count === 0
  ) {
    // Publish a fresh empty database's owner before another local caller resolves its store.
    // Yielding first leaves an occupied, unowned file that custom selectors must avoid.
    assertSqliteIntegrity(database, pathname, integrityCheck ? integrity : undefined);
  } else {
    // Pending migrations cannot inherit an earlier runtime verification.
    yield* sqliteIntegrityCheckSteps(database, pathname, diagnostics, integrity);
  }
  return hasPendingCurrentVersionMigration;
}
