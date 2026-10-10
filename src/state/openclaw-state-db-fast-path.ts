import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  readSqliteSchemaCookie,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { hasLegacyCronRunLogs } from "../infra/state-migrations.cron-run-logs.js";
import {
  getStateRuntimeSchemaAdmission,
  publishStateRuntimeSchemaAdmission,
} from "./openclaw-state-db-admission.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateRuntimeIntegrity } from "./openclaw-state-db-integrity-admission.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  assertCanonicalStateSchemaShape,
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
} from "./openclaw-state-db-schema-repair.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  isOpenClawStateStartupRepairableSchemaIssue,
  STATE_RUNTIME_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function needsOpenClawStateDatabaseSchemaRepair(
  pathname: string,
  scope: "automatic" | "doctor" = "automatic",
): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    if (scope === "automatic" && getStateRuntimeSchemaAdmission(database)?.startupReady) {
      return false;
    }
    assertSupportedStateSchemaVersion(database, pathname);
    const needsRepair =
      readStateSchemaContentVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      hasLegacyCronRunLogs(database) ||
      detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0;
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
      if (scope === "doctor") {
        assertSqliteIntegrity(database, pathname);
      }
    }
    return needsRepair;
  } catch {
    // Preserve the repair path's existing diagnostics for unreadable or noncanonical databases.
    return true;
  } finally {
    database?.close();
  }
}

export function assertCurrentStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  readTable?: SqliteTableContractReader,
): void {
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

export function isOpenClawStateSchemaFastPathEligible(
  database: DatabaseSync,
  pathname: string,
  integrity?: OpenClawStateIntegrityAdmission,
): boolean {
  const admitted = getStateRuntimeSchemaAdmission(database);
  if (admitted) {
    return admitted.startupReady;
  }
  let publishIntegrity: (() => void) | undefined;
  const eligible = withSqlitePostCommitPublications(database, () =>
    runSqliteDeferredTransactionSync(
      database,
      () => {
        const userVersion = assertSupportedStateSchemaVersion(database, pathname);
        if (readStateSchemaContentVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
          return false;
        }
        const schemaVersion = readSqliteSchemaCookie(database);
        if (typeof schemaVersion !== "number") {
          throw new Error(`Shared-state database ${pathname} schema version is unavailable.`);
        }
        publishIntegrity = assertOpenClawStateRuntimeIntegrity(
          database,
          pathname,
          { schemaVersion, userVersion },
          integrity,
        );
        // Both policies see this read transaction; repair must collect fresh facts after it ends.
        const readTable = createSqliteTableContractReader(database);
        assertCurrentStateRuntimeSchema(database, pathname, readTable);
        const startupRepairRequired = collectSqliteSchemaIssues(
          database,
          OPENCLAW_STATE_SCHEMA_SQL,
          STATE_RUNTIME_SCHEMA_COMPATIBILITY,
          readTable,
        ).some(isOpenClawStateStartupRepairableSchemaIssue);
        if (startupRepairRequired) {
          return false;
        }
        assertNoLegacyStateRuntimeRepair(database, pathname);
        return true;
      },
      { operationLabel: "state.admission.fast-path" },
    ),
  );
  publishIntegrity?.();
  if (eligible) {
    publishStateRuntimeSchemaAdmission(database, true);
  }
  return eligible;
}
