import { existsSync } from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  prepareClientCredentialMigration,
  prepareClientCredentialMigrationCustody,
  recoverClientCredentialStore,
} from "../infra/client-credential-migration.js";
import type { ClientCredentialCustody } from "../infra/client-credential-store.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { formatSchemaMigrationFailure } from "../infra/schema-migration-diagnostics.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { revokeSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import {
  repairDoctorSqliteIndexCorruption,
  prepareDoctorSqliteIndexCorruption,
} from "../infra/sqlite-index-recovery.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { configureSqliteMaintenanceCache } from "../infra/sqlite-maintenance-cache.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  withStateDatabaseSchemaMaintenance,
  withStateDatabaseSchemaMaintenanceAsync,
} from "../infra/state-database-maintenance.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import {
  runUpdateSqliteMigration,
  runUpdateSqliteMigrationAsync,
} from "../infra/update-doctor-migration-attribution.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { hasPreJournalStateSchema } from "./agent-deletion-journal-history.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} from "./openclaw-quarantine-store.js";
import { publishStateRuntimeSchemaAdmission } from "./openclaw-state-db-admission.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import {
  type OpenClawStateDatabaseOptions,
  LAZY_ADDITIVE_STATE_TABLES,
  DOCTOR_OWNED_STATE_TABLES,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import {
  hasDanglingSkillWorkshopCollectionReviewIndex,
  openDoctorStateSchemaReadAdmission,
} from "./openclaw-state-db-doctor-schema.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { migrateHistoricalStateImports } from "./openclaw-state-db-historical-imports.js";
import {
  assertMigratedStateTableIntegrity,
  assertOpenClawStateDatabaseOwner,
  markCurrentStateSchemaVersion,
  migrateBoundedStateSchema,
  openClawStateMigrationAssertions,
  versionedStateMigrations,
  runStateSchemaMigrationTransaction,
  executeCanonicalStateSchema,
  prepareStateDatabaseSchemaRepair,
  repairStateDatabaseSchemaReadability,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { assertOpenClawStateSchemaRepairAllowed } from "./openclaw-state-db-schema-policy.js";
import {
  assertCanonicalAgentDatabasesPrimaryKey,
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { ensureOpenClawStateRuntimeSchema } from "./openclaw-state-db-schema-runtime.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import { migratePredicateColumnsV21 } from "./openclaw-state-db-schema-v21-columns.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import { isUninitializedNativeStartupDatabase } from "./openclaw-state-db-startup-checkpoint.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import { hasOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery-preservation.js";
import {
  recoverOrphanTaskDeliveryRows,
  prepareOrphanTaskDeliveryRecovery,
} from "./openclaw-state-db-task-delivery-recovery.js";
import { resolveDatabasePath, describeAgentPathMigration } from "./openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { UpdateSchemaRefusalError } from "./openclaw-update-schema-refusal.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";

type DoctorRepairScope = "doctor" | "indexes" | "readability" | "version";
type DoctorRepairOptions = OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" };

function resolveDoctorRepairTarget(options: DoctorRepairOptions, scope: DoctorRepairScope) {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return undefined;
  }
  if (scope === "readability") {
    // A writer close may checkpoint WAL and invalidate a recorded corruption refusal.
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  }
  return { pathname, env };
}

export function repairDoctorStateSchema(options: DoctorRepairOptions, scope: DoctorRepairScope) {
  const target = resolveDoctorRepairTarget(options, scope);
  return target
    ? withStateDatabaseSchemaMaintenance({ databasePath: target.pathname }, () =>
        repairStateSchema(target.pathname, target.env, scope, options.integrityCheck),
      )
    : { changes: [], warnings: [] };
}

export async function repairDoctorStateSchemaAsync(
  options: DoctorRepairOptions,
  scope: DoctorRepairScope,
) {
  const target = resolveDoctorRepairTarget(options, scope);
  return target
    ? withStateDatabaseSchemaMaintenanceAsync({ databasePath: target.pathname }, () =>
        repairStateSchemaAsync(target.pathname, target.env, scope, options.integrityCheck),
      )
    : { changes: [], warnings: [] };
}

export function repairStateSchema(
  pathname: string,
  env: NodeJS.ProcessEnv,
  scope: "automatic" | "doctor" | "readability" | "indexes" | "version",
  integrityCheck: "quick" | "full" = "quick",
  legacyCronDefaultStoreKey?: string,
) {
  assertOpenClawStateSchemaRepairAllowed(pathname);
  // This private handle rebuilds referenced tables and is closed after repair.
  const db = openNodeSqliteDatabase(pathname, { enableForeignKeyConstraints: false });
  try {
    return runUpdateSqliteMigration(db, pathname, () =>
      repairOpenedStateSchema(db, pathname, env, scope, integrityCheck, legacyCronDefaultStoreKey),
    );
  } finally {
    if (db.isOpen) {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  }
}

type StateSchemaRepairStep = {
  sync(): void;
  prepare(): Promise<void | (() => void)>;
};

function repairOpenedStateSchema(...args: Parameters<typeof repairOpenedStateSchemaSteps>) {
  const operation = repairOpenedStateSchemaSteps(...args);
  let step = operation.next();
  while (!step.done) {
    try {
      step.value.sync();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}

/** Await preservation between attributed native phases, never inside a write transaction. */
export async function repairStateSchemaAsync(
  ...args: Parameters<typeof repairStateSchema>
): Promise<ReturnType<typeof repairStateSchema>> {
  const [pathname, env, scope, integrityCheck = "quick", legacyCronDefaultStoreKey] = args;
  const signal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
  assertOpenClawStateSchemaRepairAllowed(pathname);
  const db = openNodeSqliteDatabase(pathname, { enableForeignKeyConstraints: false });
  const preparation: { credentialCustody?: ClientCredentialCustody | null } = {};
  const operation = repairOpenedStateSchemaSteps(
    db,
    pathname,
    env,
    scope,
    integrityCheck,
    legacyCronDefaultStoreKey,
    preparation,
  );
  const resume = (failure?: { error: unknown }, prepared?: void | (() => void)) =>
    runUpdateSqliteMigrationAsync(
      db,
      pathname,
      () => {
        signal?.throwIfAborted();
        return failure ? operation.throw(failure.error) : operation.next(prepared);
      },
      {
        companions: preparation.credentialCustody ? [preparation.credentialCustody] : [],
      },
    );
  try {
    let step = await resume();
    while (!step.done) {
      let failure: { error: unknown } | undefined;
      let prepared: void | (() => void) = undefined;
      try {
        prepared = await step.value.prepare();
      } catch (error) {
        failure = { error };
      }
      step = await resume(failure, prepared);
    }
    signal?.throwIfAborted();
    return step.value;
  } finally {
    try {
      operation.return({ changes: [], warnings: [] });
    } finally {
      try {
        preparation.credentialCustody?.close();
      } finally {
        if (db.isOpen) {
          clearNodeSqliteKyselyCacheForDatabase(db);
          db.close();
        }
      }
    }
  }
}

function* repairOpenedStateSchemaSteps(
  db: import("node:sqlite").DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
  scope: "automatic" | "doctor" | "readability" | "indexes" | "version",
  integrityCheck: "quick" | "full",
  legacyCronDefaultStoreKey?: string,
  preparation: { credentialCustody?: ClientCredentialCustody | null } = {},
): Generator<
  StateSchemaRepairStep,
  { changes: string[]; warnings: string[] },
  void | (() => void)
> {
  const rebuiltIndexNames = new Set<string>();
  let indexChanges: string[] = [];
  let ownershipRefused = false;
  try {
    if (scope !== "automatic") {
      revokeSqliteDatabaseAdmissions(db);
    }
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    const closeReadAdmission =
      scope === "automatic" ? undefined : openDoctorStateSchemaReadAdmission(db);
    try {
      assertOpenClawStateWriteAllowed({
        database: db,
        databasePath: pathname,
        env,
        inspectOwnership: scope === "automatic" ? undefined : true,
      });
      assertCanonicalAgentDatabasesPrimaryKey(db, pathname);
    } finally {
      closeReadAdmission?.();
    }
    ensureOpenClawStatePermissions(pathname, env);
    if (scope === "automatic") {
      return {
        changes: ensureOpenClawStateRuntimeSchema(
          db,
          pathname,
          env,
          {
            kind: "existing",
          },
          undefined,
          false,
          legacyCronDefaultStoreKey,
        ),
        warnings: [],
      };
    }
    // Private preservation readers cannot inspect the recognized malformed catalog.
    // Publish its owner-rechecked repair before credential or orphan preparation.
    const unreadableCatalog =
      scope === "doctor" && hasDanglingSkillWorkshopCollectionReviewIndex(db);
    let catalogChanges: string[] = [];
    if (unreadableCatalog) {
      const apply = yield {
        sync() {},
        async prepare() {
          return () => {
            catalogChanges = repairStateDatabaseSchemaReadability(db, pathname, env);
          };
        },
      };
      if (apply) {
        apply();
      }
    }
    if (scope === "version" || scope === "doctor") {
      yield {
        sync() {},
        async prepare() {
          const closeAdmission = openDoctorStateSchemaReadAdmission(db);
          let fromVersion: number;
          try {
            fromVersion = readStateSchemaContentVersion(db);
          } finally {
            closeAdmission?.();
          }
          preparation.credentialCustody =
            (await prepareClientCredentialMigrationCustody({
              path: pathname,
              env,
              fromVersion,
            })) ?? null;
        },
      };
    }
    if (scope === "version") {
      const changes = runStateSchemaMigrationTransaction(
        db,
        pathname,
        () => {
          assertOpenClawStateDatabaseOwner(db, { pathname });
          const previousVersion = readStateSchemaContentVersion(db);
          if (previousVersion === 0 && !isUninitializedNativeStartupDatabase(db)) {
            throw new Error(
              "Unrecognized native bootstrap database; preserve it for explicit recovery.",
            );
          }
          prepareClientCredentialMigration(db, {
            path: pathname,
            env,
            fromVersion: previousVersion,
            custody: preparation.credentialCustody,
          });
          if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
            recoverClientCredentialStore(db, {
              path: pathname,
              env,
              custody: preparation.credentialCustody,
            });
            return [];
          }
          const applied = migrateBoundedStateSchema(db, previousVersion, {
            env,
            legacyCronDefaultStoreKey,
            versionMigrationOnly: true,
          });
          if (!applied) {
            throw new Error(`No bounded shared-state migration from v${previousVersion}.`);
          }
          markCurrentStateSchemaVersion(db);
          assertMigratedStateTableIntegrity(db, pathname, previousVersion);
          return applied;
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: pathname,
          operationLabel: "state.schema.version-migration",
        },
      );
      // Full-shape admission and quarantine cleanup belong to later Doctor repair.
      return { changes, warnings: [] };
    }
    const repairAdmittedSchema = prepareStateDatabaseSchemaRepair(db, pathname, env);
    const canInspectIndexes =
      scope !== "readability" && !hasDanglingSkillWorkshopCollectionReviewIndex(db);
    let previousVersion = canInspectIndexes ? readStateSchemaContentVersion(db) : undefined;
    let integrity =
      previousVersion === undefined
        ? undefined
        : resolveSchemaMigrationIntegrityCheck(
            {
              kind: "state",
              foundVersion: previousVersion,
              supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            },
            integrityCheck,
          );
    const assertIndexRepairCurrent = () => {
      assertOpenClawStateDatabaseOwner(db, { pathname });
      assertOpenClawStateWriteAllowed({
        database: db,
        databasePath: pathname,
        env,
        inspectOwnership: true,
      });
    };
    const recordedDamage =
      canInspectIndexes &&
      Boolean(
        openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(pathname) ||
        readOpenClawDatabaseQuarantineFailure("state", pathname, { env, fresh: true }),
      );
    let scanCorruptIndexes = recordedDamage || (scope === "indexes" && integrityCheck === "full");
    let sourceIntegrityVerified = false;
    if (canInspectIndexes && !scanCorruptIndexes) {
      try {
        assertSqliteIntegrity(db, pathname, integrity);
        sourceIntegrityVerified = true;
      } catch (error) {
        if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
          scanCorruptIndexes = true;
        } else if (!(error instanceof SqliteRepairableForeignKeyError)) {
          throw error;
        }
        // Known orphan rows retain their preserving recovery inside the write transaction.
      }
    }
    if (canInspectIndexes && scanCorruptIndexes) {
      let applyIndexRepair: (() => string[]) | undefined;
      const repairOptions = { label: "shared-state", assertCurrent: assertIndexRepairCurrent };
      yield {
        sync() {
          indexChanges = repairDoctorSqliteIndexCorruption(db, pathname, repairOptions);
        },
        async prepare() {
          applyIndexRepair = await prepareDoctorSqliteIndexCorruption(db, pathname, repairOptions);
        },
      };
      if (applyIndexRepair) {
        indexChanges = applyIndexRepair();
      }
    }
    if (indexChanges.length > 0) {
      sourceIntegrityVerified = true;
    } else if (recordedDamage) {
      // A clean quick result cannot retire a recorded full-integrity failure.
      assertSqliteIntegrity(db, pathname);
      sourceIntegrityVerified = true;
    }
    if (scope === "indexes") {
      if (canInspectIndexes && (indexChanges.length > 0 || recordedDamage)) {
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertIndexRepairCurrent();
            if (!clearOpenClawDatabaseQuarantine(pathname, { env })) {
              throw new Error(
                `Repaired ${pathname}, but its quarantine record could not be cleared.`,
              );
            }
            clearOpenClawStateDatabaseOpenFailure(pathname);
          },
          {
            databaseLabel: pathname,
            operationLabel: "state.schema.quarantine-clear",
          },
        );
      }
      return { changes: indexChanges, warnings: [] };
    }
    if (scope === "readability") {
      const changes = repairStateDatabaseSchemaReadability(db, pathname, env);
      // Recovery snapshots committed source bytes in another process. Publish
      // catalog readability before its preservation transaction inspects them.
      let recover = () => recoverOrphanTaskDeliveryRows(db, pathname);
      if (hasOrphanTaskDeliveryRows(db)) {
        yield {
          sync() {},
          async prepare() {
            recover = await prepareOrphanTaskDeliveryRecovery(db, pathname);
          },
        };
      }
      changes.push(
        ...runSqliteImmediateTransactionSync(
          db,
          () => {
            assertOpenClawStateWriteAllowed({
              database: db,
              databasePath: pathname,
              env,
              inspectOwnership: true,
            });
            return recover();
          },
          {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: pathname,
            operationLabel: "state.schema.readability-recovery",
          },
        ),
      );
      return { changes, warnings: [] };
    }
    const applied: string[] = [...catalogChanges, ...indexChanges];
    let recover = () => recoverOrphanTaskDeliveryRows(db, pathname);
    if ((!unreadableCatalog || catalogChanges.length > 0) && hasOrphanTaskDeliveryRows(db)) {
      yield {
        sync() {},
        async prepare() {
          recover = await prepareOrphanTaskDeliveryRecovery(db, pathname);
        },
      };
    }
    const changes = runStateSchemaMigrationTransaction(
      db,
      pathname,
      () => {
        previousVersion ??= readStateSchemaContentVersion(db);
        integrity ??= resolveSchemaMigrationIntegrityCheck(
          {
            kind: "state",
            foundVersion: previousVersion,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          },
          integrityCheck,
        );
        if (previousVersion === 0 && !isUninitializedNativeStartupDatabase(db)) {
          throw new Error(
            "Unrecognized native bootstrap database; preserve it for explicit recovery.",
          );
        }
        const preAuditSchema = previousVersion === 1 && !tableExists(db, "audit_events");
        if (preAuditSchema) {
          assertOpenClawStateDatabaseOwner(db, { pathname });
        }
        prepareClientCredentialMigration(db, {
          path: pathname,
          env,
          fromVersion: previousVersion,
          custody: preparation.credentialCustody,
        });
        applied.push(...recover());
        if (!sourceIntegrityVerified) {
          assertSqliteIntegrity(db, pathname, integrity);
        }
        applied.push(...migrateHistoricalStateImports(db, previousVersion, "doctor"));
        if (previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
          openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
          const boundedChanges = migrateBoundedStateSchema(db, previousVersion, {
            env,
            legacyCronDefaultStoreKey,
          });
          if (boundedChanges) {
            applied.push(...boundedChanges);
            markCurrentStateSchemaVersion(db);
            assertCurrentStateRuntimeSchema(db, pathname);
            assertMigratedStateTableIntegrity(db, pathname, previousVersion);
            return applied;
          }
        }
        const includeAgentDeletionJournal =
          tableExists(db, "agent_deletion_journal") || hasPreJournalStateSchema(db);
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          recoverClientCredentialStore(db, {
            path: pathname,
            env,
            custody: preparation.credentialCustody,
          });
          // Current-schema doctor repair may normalize recognized columns or
          // table options, but it must never recreate a missing table empty.
          assertSqliteSchemaTablesPresent(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowedMissingTables: [...LAZY_ADDITIVE_STATE_TABLES, ...DOCTOR_OWNED_STATE_TABLES],
          });
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
        // Recognized native bootstrap and schema-1 stores predate audit; Doctor must
        // finish their schema before later workspace and agent readers consume it.
        if (previousVersion === 0 || preAuditSchema || tableExists(db, "audit_events")) {
          // Historical delivery repair below already writes and reads the promoted columns.
          if (migratePredicateColumnsV21(db, previousVersion)) {
            applied.push(
              "Derived meeting transcript selectors and bounded delivery retention columns (v21)",
            );
          }
          ensureAdditiveStateColumns(db, "repair");
          for (const migration of versionedStateMigrations) {
            if (migration.migrate(db, previousVersion, { env, legacyCronDefaultStoreKey })) {
              applied.push(migration.applied);
            }
          }
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
            includeAgentDeletionJournal,
          });
          migrateLegacyCronRunLogsToTaskRuns(db);
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
              includeAgentDeletionJournal: tableExists(db, "agent_deletion_journal"),
            }),
            { databaseLabel: pathname, integrityCheck },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
            integrity,
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
        if (previousVersion < OPENCLAW_STATE_SCHEMA_VERSION) {
          assertMigratedStateTableIntegrity(db, pathname, previousVersion, true);
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
        applied.push(...repairAdmittedSchema());
        configureSqliteMaintenanceCache(db);
      },
    );
    const quarantineCleared = clearOpenClawDatabaseQuarantine(pathname, { env });
    clearOpenClawStateDatabaseOpenFailure(pathname);
    if (readStateSchemaContentVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
      publishStateRuntimeSchemaAdmission(db, true);
    }
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
    const warning = formatSchemaMigrationFailure(
      "Failed migrating shared state database schema",
      pathname,
      err,
    );
    const reason =
      scope === "automatic"
        ? warning
        : warning.replace(
            /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\.?/u,
            "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
          );
    // Keep the existing fixed public classification separate from local cause details.
    const diagnostic =
      extractErrorCode(err) === "CLIENT_CREDENTIAL_SOCKET_INVALID"
        ? "Client credential socket material is invalid.\n"
        : "";
    return {
      changes: indexChanges,
      warnings: [`${diagnostic}${reason}`],
    };
  } finally {
    if (!ownershipRefused) {
      ensureOpenClawStatePermissions(pathname, env);
    }
  }
}
