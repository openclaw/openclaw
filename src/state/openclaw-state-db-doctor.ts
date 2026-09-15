import { existsSync } from "node:fs";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity, assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { withStateSchemaFence } from "../infra/state-database-coordinator.js";
import { clearOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import {
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertCurrentStateRuntimeSchema,
  needsOpenClawStateDatabaseSchemaRepair,
} from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseOwner,
  markCurrentStateSchemaVersion,
  openClawStateMigrationAssertions,
  resolveDatabasePath,
  versionedStateMigrations,
  runStateSchemaMigrationTransaction,
  executeCanonicalStateSchema,
  prepareStateDatabaseSchemaRepair,
  openStateDatabaseDoctorOwnershipReadAdmission,
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
  readStateSchemaContentVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import { recoverOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery.js";
import { describeAgentPathMigration } from "./openclaw-state-db.paths.js";
import {
  OpenClawStateOwnershipError,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { UpdateSchemaRefusalError } from "./openclaw-update-schema-refusal.js";

function repairStateSchema(
  pathname: string,
  env: NodeJS.ProcessEnv,
  scope: "schema" | "catalog" = "schema",
): {
  changes: string[];
  warnings: string[];
} {
  let repairing = scope === "schema";
  if (repairing) {
    ensureOpenClawStatePermissions(pathname, env);
  }
  const db = openNodeSqliteDatabase(pathname);
  const rebuiltIndexNames = new Set<string>();
  let ownershipRefused = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const schemaRepair = prepareStateDatabaseSchemaRepair(db, pathname, env);
    if (scope === "catalog") {
      if (!schemaRepair.needsCatalogRepair) {
        return { changes: [], warnings: [] };
      }
      repairing = true;
      ensureOpenClawStatePermissions(pathname, env);
    }
    db.exec("PRAGMA foreign_keys = OFF;");
    const runRepairTransaction =
      scope === "catalog"
        ? (operation: () => string[], options: SqliteTransactionOptions) =>
            runSqliteImmediateTransactionSync(db, operation, options)
        : (operation: () => string[], options: SqliteTransactionOptions) =>
            runStateSchemaMigrationTransaction(db, pathname, operation, options);
    const changes = runRepairTransaction(
      () => {
        const applied = schemaRepair.repair();
        if (scope === "catalog") {
          assertOpenClawStateDatabaseOwner(db, { pathname });
          // Unrelated repairable state belongs to the later full schema step.
          assertSqliteTableIntegrity(db, pathname, "skill_workshop_collection_reviews");
          return applied;
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
    );
    if (scope === "catalog") {
      return { changes, warnings: [] };
    }
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
      db.exec("PRAGMA foreign_keys = ON;");
      clearNodeSqliteKyselyCacheForDatabase(db);
      // Rollback cleanup may have closed the handle after an unrecoverable
      // transaction failure; double-close throws ERR_INVALID_STATE and would
      // discard the diagnostic warnings returned by the catch above.
      db.close();
    }
    if (repairing && !ownershipRefused) {
      ensureOpenClawStatePermissions(pathname, env);
    }
  }
}

export function repairOpenClawStateDatabaseSchema(
  options: OpenClawStateDatabaseOptions = {},
  scope: "schema" | "catalog" = "schema",
): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  if (scope === "catalog") {
    // Writable ownership admission can checkpoint WAL and expire a recorded failure's generation.
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  }
  return runWithOpenClawStateWriteAccess(
    {
      databasePath: pathname,
      env,
      schemaReadAdmission: openStateDatabaseDoctorOwnershipReadAdmission,
    },
    "state schema repair",
    () =>
      withStateSchemaFence({ databasePath: pathname }, () =>
        repairStateSchema(pathname, env, scope),
      ),
  );
}

/** Skip the exclusive doctor repair when automatic migration sees a canonical current schema. */
export function repairOpenClawStateDatabaseSchemaIfNeeded(
  options: OpenClawStateDatabaseOptions = {},
): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }

  return runWithOpenClawStateWriteAccess(
    {
      databasePath: pathname,
      env,
      schemaReadAdmission: openStateDatabaseDoctorOwnershipReadAdmission,
    },
    "state schema repair preflight/repair",
    () =>
      needsOpenClawStateDatabaseSchemaRepair(pathname)
        ? withStateSchemaFence({ databasePath: pathname }, () => repairStateSchema(pathname, env))
        : { changes: [], warnings: [] },
  );
}
