import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { hasLegacyCronRunLogs } from "../infra/state-migrations.cron-run-logs.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  assertCanonicalStateSchemaShape,
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
} from "./openclaw-state-db-schema-repair.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  getOpenClawStateRuntimeSchema,
  isOpenClawStateStartupRepairableSchemaIssue,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

export function needsOpenClawStateDatabaseSchemaRepair(pathname: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    assertSupportedStateSchemaVersion(database, pathname);
    const needsRepair =
      readStateSchemaMigrationVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      hasLegacyCronRunLogs(database) ||
      detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0;
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
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
): boolean {
  return runSqliteDeferredTransactionSync(database, () => {
    assertSupportedStateSchemaVersion(database, pathname);
    if (readStateSchemaMigrationVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      return false;
    }
    assertSqliteIntegrity(database, pathname);
    // Both policies see this read transaction; repair must collect fresh facts after it ends.
    const readTable = createSqliteTableContractReader(database);
    assertCurrentStateRuntimeSchema(database, pathname, readTable);
    const startupRepairRequired = collectSqliteSchemaIssues(
      database,
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
      readTable,
    ).some(isOpenClawStateStartupRepairableSchemaIssue);
    if (startupRepairRequired) {
      return false;
    }
    assertNoLegacyStateRuntimeRepair(database, pathname);
    return true;
  });
}
