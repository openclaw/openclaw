import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity, assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { clearOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { clearOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import {
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseOwner,
  markCurrentStateSchemaVersion,
  openClawStateMigrationAssertions,
  versionedStateMigrations,
  runStateSchemaMigrationTransaction,
  executeCanonicalStateSchema,
  prepareStateDatabaseSchemaRepair,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairAgentDatabasesCompositePrimaryKey,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import { recoverOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery.js";
import { describeAgentPathMigration } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  OpenClawStateOwnershipError,
} from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { UpdateSchemaRefusalError } from "./openclaw-update-schema-refusal.js";

export function repairStateSchema(
  pathname: string,
  env: NodeJS.ProcessEnv,
  scope: "automatic" | "doctor" | "readability",
): {
  changes: string[];
  warnings: string[];
} {
  ensureOpenClawStatePermissions(pathname, env);
  // This private handle rebuilds referenced tables and is closed after repair.
  const db = openNodeSqliteDatabase(pathname, { enableForeignKeyConstraints: false });
  const rebuiltIndexNames = new Set<string>();
  let ownershipRefused = false;
  try {
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    const repairAdmittedSchema =
      scope === "automatic" ? undefined : prepareStateDatabaseSchemaRepair(db, pathname, env);
    if (!repairAdmittedSchema) {
      assertSupportedStateSchemaVersion(db, pathname);
    } else if (scope === "readability") {
      return {
        changes: runSqliteImmediateTransactionSync(
          db,
          () => {
            const changes = repairAdmittedSchema();
            if (changes.length > 0) {
              assertOpenClawStateDatabaseOwner(db, { pathname });
              assertSqliteTableIntegrity(db, pathname, "skill_workshop_collection_reviews");
            }
            return changes;
          },
          {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: pathname,
            operationLabel: "state.schema.readability-repair",
          },
        ),
        warnings: [],
      };
    }
    const applied: string[] = [];
    const changes = runStateSchemaMigrationTransaction(
      db,
      pathname,
      () => {
        if (!repairAdmittedSchema) {
          assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
        }
        applied.push(...recoverOrphanTaskDeliveryRows(db, pathname));
        const previousVersion = readStateSchemaMigrationVersion(db);
        const preAuditSchema = previousVersion === 1 && !tableExists(db, "audit_events");
        if (preAuditSchema) {
          assertOpenClawStateDatabaseOwner(db, { pathname });
        }
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          for (const name of verifyAndRepairCanonicalSqliteIndexes(
            db,
            pathname,
            OPENCLAW_STATE_SCHEMA_SQL,
            { allowMissingColumns: true },
          )) {
            rebuiltIndexNames.add(name);
          }
          // Current-schema doctor repair may normalize recognized columns or
          // table options, but it must never recreate a missing table empty.
          assertSqliteSchemaTablesPresent(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowedMissingTables: LAZY_ADDITIVE_STATE_TABLES,
          });
        } else {
          openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
          assertSqliteIntegrity(db, pathname);
        }
        dropLegacyStateTables(db);
        applied.push(...retirements.runRetiredStateTableMigrations(db, previousVersion));
        if (migrateSingletonStateFoldInV12(db, previousVersion)) {
          applied.push("Folded singleton state tables into config_machine_state (v12)");
        }
        if (migrateWorkerPlacementExecutionModeSchema(db, previousVersion)) {
          applied.push("Migrated cloud worker placements to execution modes");
        }
        applied.push(
          ...describeAgentPathMigration(migrateAgentPaths(db, previousVersion, pathname)),
        );
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        applied.push(...operatorApprovalMigration.repairOperatorApprovalSchema(db));
        const needsSessionWatchMigration =
          sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, previousVersion);
        const sessionWatchResult = sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        if (needsSessionWatchMigration) {
          applied.push(
            `Migrated shared state session watch cursors → provenance column (${sessionWatchResult.migratedAmbientWatches} ambient, ${sessionWatchResult.removedLegacySentinels} sentinels removed)`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        // Recognized schema-1 stores predate audit; Doctor must finish their schema
        // before its later read-only workspace and agent readers can consume it.
        if (preAuditSchema || tableExists(db, "audit_events")) {
          ensureAdditiveStateColumns(db);
          for (const migration of versionedStateMigrations) {
            if (migration.migrate(db, previousVersion)) {
              applied.push(migration.applied);
            }
          }
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
          });
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          })) {
            rebuiltIndexNames.add(name);
          }
        }
        markCurrentStateSchemaVersion(db, {
          createMetadataIfMissing: previousVersion < OPENCLAW_STATE_SCHEMA_VERSION,
        });
        if (readStateSchemaContentVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
          assertCurrentStateRuntimeSchema(db, pathname);
        }
        if (rebuiltIndexNames.size > 0) {
          applied.push(`Rebuilt canonical shared-state SQLite indexes (${rebuiltIndexNames.size})`);
        }
        return applied;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
      () => {
        applied.push(...(repairAdmittedSchema?.() ?? []));
      },
    );
    const quarantineCleared = clearOpenClawDatabaseQuarantine(pathname, { env });
    clearOpenClawStateDatabaseOpenFailure(pathname);
    return {
      changes,
      warnings: quarantineCleared
        ? []
        : [
            `Persisted quarantine record for ${pathname} could not be cleared; rerun openclaw doctor --fix so the repaired database is not refused again.`,
          ],
    };
  } catch (err) {
    if (err instanceof UpdateSchemaRefusalError) {
      throw err;
    }
    if (err instanceof OpenClawStateOwnershipError) {
      ownershipRefused = true;
      throw err;
    }
    // Reaching this catch inside doctor means repair itself refused or failed,
    // so the runtime asserts' "run openclaw doctor --fix" advice is circular here.
    const reason = String(err).replace(
      /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\./u,
      "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
    );
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${reason}`],
    };
  } finally {
    if (db.isOpen) {
      clearNodeSqliteKyselyCacheForDatabase(db);
      // Rollback cleanup may have closed the handle after an unrecoverable
      // transaction failure; double-close throws ERR_INVALID_STATE and would
      // discard the diagnostic warnings returned by the catch above.
      db.close();
    }
    if (!ownershipRefused) {
      ensureOpenClawStatePermissions(pathname, env);
    }
  }
}
