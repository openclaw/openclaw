import type { DatabaseSync } from "node:sqlite";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { withStateSchemaFence } from "../infra/state-database-coordinator.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import {
  assertCurrentStateRuntimeSchema,
  assertNoLegacyStateRuntimeRepair,
  isOpenClawStateSchemaFastPathEligible,
} from "./openclaw-state-db-fast-path.js";
import type { StateDatabaseInitialization } from "./openclaw-state-db-initialization.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  executeCanonicalStateSchema,
  openClawStateMigrationAssertions,
  runStateSchemaMigrationTransaction,
  versionedStateMigrations,
  writeCurrentStateSchemaMetadata,
} from "./openclaw-state-db-maintenance.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import { migrateSessionWatchCursorProvenance } from "./openclaw-state-db-session-watch-migration.js";
import { isUninitializedNativeStartupDatabase } from "./openclaw-state-db-startup-checkpoint.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import { describeAgentPathMigration, warnAgentPathMigration } from "./openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const stateDbLog = createSubsystemLogger("state/db");

/** Runtime converges schema; historical row repair belongs to explicit Doctor maintenance. */
export function ensureOpenClawStateRuntimeSchema(
  db: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
  initialization: StateDatabaseInitialization,
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  initializeNativeOnly = false,
): string[] {
  if (isExistingOpenClawStateSchema(pathname, db)) {
    assertExistingOpenClawStateRuntimeSchema(db, pathname);
    assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
    return [];
  }
  try {
    if (isOpenClawStateSchemaFastPathEligible(db, pathname)) {
      // A claim made during validation must not retain a writable handle.
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      return [];
    }
  } catch (error) {
    if (!db.isOpen || error instanceof StartupMaintenanceRequiredError) {
      throw error;
    }
    // Preserve transactional schema convergence and its diagnostics after a clean rollback.
  }

  return withStateSchemaFence({ databasePath: pathname }, () => {
    const now = Date.now();
    const retiredTableChanges: string[] = [];
    const applied = runStateSchemaMigrationTransaction(
      db,
      pathname,
      () => {
        assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
        assertSupportedStateSchemaVersion(db, pathname);
        if (initializeNativeOnly && !isUninitializedNativeStartupDatabase(db)) {
          return [];
        }
        const previousVersion = readStateSchemaMigrationVersion(db);
        const includeAgentDeletionJournal =
          tableExists(db, "agent_deletion_journal") ||
          (initialization.kind === "fresh" && isUninitializedNativeStartupDatabase(db));
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          assertNoLegacyStateRuntimeRepair(db, pathname);
          const indexes = verifyAndRepairCanonicalSqliteIndexes(
            db,
            pathname,
            OPENCLAW_STATE_SCHEMA_SQL,
            {
              allowMissingColumns: true,
              validateAfterRepair: () => assertCurrentStateRuntimeSchema(db, pathname),
            },
          );
          ensureAdditiveStateColumns(db, "runtime");
          assertCurrentStateRuntimeSchema(db, pathname);
          writeCurrentStateSchemaMetadata(db, now);
          return indexes.length > 0
            ? [`Rebuilt canonical shared-state SQLite indexes (${indexes.length})`]
            : [];
        }

        // Older schemas still need atomic content transforms before retiring their columns.
        openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
        // Automatic preparation enters without the physical opener's integrity preflight.
        assertSqliteIntegrity(db, pathname);
        dropLegacyStateTables(db);
        const changes = retirements.runRetiredStateTableMigrations(db, previousVersion);
        retiredTableChanges.push(...changes);
        if (migrateSingletonStateFoldInV12(db, previousVersion)) {
          changes.push("Folded singleton state tables into config_machine_state (v12)");
        }
        if (migrateWorkerPlacementExecutionModeSchema(db, previousVersion)) {
          changes.push("Migrated cloud worker placements to execution modes");
        }
        const pathMigration = migrateAgentDatabaseRelativePaths(db, previousVersion, pathname);
        changes.push(...describeAgentPathMigration(pathMigration));
        ensureAdditiveStateColumns(db, "repair");
        for (const migration of versionedStateMigrations) {
          if (migration.migrate(db, previousVersion)) {
            changes.push(migration.applied);
          }
        }
        migrateSessionWatchCursorProvenance(db);
        assertCanonicalStateSchemaShape(db, pathname);
        executeCanonicalStateSchema(db, {
          includeVersionLazyAdditiveTables: true,
          includeAgentDeletionJournal,
        });
        migrateLegacyCronRunLogsToTaskRuns(db);
        if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
          repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          const strict = migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: true,
              includeAgentDeletionJournal,
            }),
            { databaseLabel: pathname },
          );
          if (strict.migratedTables.length > 0) {
            changes.push(
              `Migrated shared state tables to SQLite STRICT typing (${strict.migratedTables.length})`,
            );
          }
        }
        repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
          verifyPhysicalIntegrity: false,
        });
        writeCurrentStateSchemaMetadata(db, now);
        assertOpenClawStateDatabaseForMaintenance(db, { pathname });
        warnAgentPathMigration(stateDbLog, pathMigration, pathname);
        return changes;
      },
      { busyTimeoutMs, databaseLabel: pathname, operationLabel: "state.schema.ensure" },
    );
    retiredTableChanges.forEach(retirements.logRetiredStateTableMigration);
    return applied;
  });
}
