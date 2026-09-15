import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeSqliteNonNegativeInteger,
  readSqliteBusyTimeout,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import type { SqliteTransactionOptions } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  StateSchemaMutationConflictError,
  withStateSchemaFence,
} from "../infra/state-database-coordinator.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  openClawStateDatabaseCache as stateDbCache,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import {
  assertCurrentStateRuntimeSchema,
  isOpenClawStateSchemaFastPathEligible,
  needsOpenClawStateDatabaseSchemaRepair,
} from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  markCurrentStateSchemaVersion,
  openClawStateMigrationAssertions,
  resolveDatabasePath,
  versionedStateMigrations,
  runStateSchemaMigrationTransaction,
  writeCurrentStateSchemaMetadata,
  executeCanonicalStateSchema,
} from "./openclaw-state-db-maintenance.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { repairStateSchema } from "./openclaw-state-db-repair.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import {
  type AgentDatabasePathMigrationSummary as AgentPathSummary,
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import {
  initializeNativeOpenClawStateConnection,
  isUninitializedNativeStartupDatabase,
  withOpenClawStateStartupCheckpointConnection,
} from "./openclaw-state-db-startup-checkpoint.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import {
  runCoordinatedStateTransaction,
  withSharedStateWriteCoordinator,
} from "./openclaw-state-db-write-coordination.js";
import { warnAgentPathMigration } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  isOpenClawStateWriteContentionError,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import {
  readStateSchemaPublicationBlocker,
  type StateSchemaPublicationBlocker,
} from "./openclaw-state-schema-publication.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
export type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
export { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
export { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
export { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db-schema-repair.js";

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowed(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const env = options.env ?? process.env;
  stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(resolveDatabasePath(options), env);
}

const stateDbLog = createSubsystemLogger("state/db");
const deferredStateDatabases = new WeakSet<DatabaseSync>();

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
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
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    },
    "state schema repair",
    () =>
      withStateSchemaFence({ databasePath: pathname }, () =>
        repairStateSchema(pathname, env, "doctor"),
      ),
  );
}

/** Make exact legacy catalog damage readable before Doctor loads config-dependent state. */
export function repairOpenClawStateDatabaseReadabilityForDoctor(
  options: OpenClawStateDatabaseOptions = {},
): { changes: string[]; warnings: string[] } {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  return runWithOpenClawStateWriteAccess(
    {
      databasePath: pathname,
      env,
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    },
    "Doctor state readability repair",
    () =>
      withStateSchemaFence({ databasePath: pathname }, () =>
        repairStateSchema(pathname, env, "readability"),
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
    { databasePath: pathname, env },
    "state schema repair preflight/repair",
    () =>
      needsOpenClawStateDatabaseSchemaRepair(pathname)
        ? withStateSchemaFence({ databasePath: pathname }, () =>
            repairStateSchema(pathname, env, "automatic"),
          )
        : { changes: [], warnings: [] },
  );
}

function ensureSchema(
  db: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  initializeNativeOnly = false,
): void {
  try {
    if (isOpenClawStateSchemaFastPathEligible(db, pathname)) {
      // Recheck ownership so a claim made during validation cannot retain a writable handle.
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      return;
    }
  } catch {
    // Preserve the existing transactional repair and its diagnostics for drift or corruption.
  }

  withStateSchemaFence({ databasePath: pathname }, () => {
    const now = Date.now();
    db.exec("PRAGMA foreign_keys = OFF;"); // Rebuilding referenced tables requires this before BEGIN.
    try {
      runStateSchemaMigrationTransaction(
        db,
        pathname,
        () => {
          // Recheck ownership after BEGIN IMMEDIATE to exclude a concurrent external claim.
          assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
          assertSupportedStateSchemaVersion(db, pathname);
          // Native bootstrap admission is advisory until this transaction owns the
          // write. Never migrate state initialized or occupied by a concurrent owner.
          if (initializeNativeOnly && !isUninitializedNativeStartupDatabase(db)) {
            return [];
          }
          const previousVersion = readStateSchemaMigrationVersion(db);
          if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
            verifyAndRepairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
              allowMissingColumns: true,
              validateAfterRepair: () => assertCurrentStateRuntimeSchema(db, pathname),
            });
            ensureAdditiveStateColumns(db);
            assertCurrentStateRuntimeSchema(db, pathname);
          } else {
            openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
          }
          dropLegacyStateTables(db);
          const retirementMessages = retirements.runRetiredStateTableMigrations(
            db,
            previousVersion,
          );
          migrateSingletonStateFoldInV12(db, previousVersion);
          migrateWorkerPlacementExecutionModeSchema(db, previousVersion);
          const pathMigration: AgentPathSummary = migrateAgentPaths(db, previousVersion, pathname);
          ensureAdditiveStateColumns(db);
          for (const migration of versionedStateMigrations) {
            migration.migrate(db, previousVersion);
          }
          sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
          assertCanonicalStateSchemaShape(db, pathname);
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
          });
          migrateLegacyCronRunLogsToTaskRuns(db);
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
            migrateSqliteSchemaToStrictInTransaction(
              db,
              getOpenClawStateRuntimeSchema({
                includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
              }),
              { databaseLabel: pathname },
            );
          }
          repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          });
          writeCurrentStateSchemaMetadata(db, now);
          assertOpenClawStateDatabaseForMaintenance(db, { pathname });
          warnAgentPathMigration(stateDbLog, pathMigration, pathname);
          return retirementMessages;
        },
        {
          busyTimeoutMs,
          databaseLabel: pathname,
          operationLabel: "state.schema.ensure",
        },
      ).forEach(retirements.logRetiredStateTableMigration);
    } finally {
      if (db.isOpen) {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }
  });
}

/** Bootstrap fresh/native-only state canonically before startup checkpoint access. */
export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  return withOpenClawStateStartupCheckpointConnection(callback, options, ensureSchema);
}

/** Complete native bootstrap without migrating mature shared state. */
export function initializeNativeOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): void {
  initializeNativeOpenClawStateConnection(options, (db, pathname, env) =>
    ensureSchema(db, pathname, env, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, true),
  );
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): Promise<OpenClawStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  assertOpenClawStateDatabaseFreshOpenAllowed(options);
  const prepared = await prepareSqliteReadOnlyLocation(pathname);
  const connection = openOpenClawStateReadConnection(pathname, prepared);
  const { db } = connection.database;
  try {
    assertSupportedStateSchemaVersion(db, pathname);
    assertSqliteIntegrity(db, pathname);
    if (readStateSchemaContentVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
      assertOpenClawStateDatabaseForMaintenance(db, { pathname });
    }
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Preserve the verification failure that explains why the database was refused.
    }
    throw error;
  }
  return {
    db,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close: connection.close,
    },
  };
}

/** Open or return a cached shared state database after schema and migration checks. */

function openOpenClawStateDatabaseWithBusyTimeout(
  options: OpenClawStateDatabaseOptions = {},
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  lockFailureReporting: SqliteLockFailureReporting = "report",
): OpenClawStateDatabase {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const env = options.env ?? process.env;
  if (options.database) {
    assertOpenClawStateWriteAllowed({
      database: options.database.db,
      databasePath: options.database.path,
      env,
    });
    observeOpenClawDatabaseMaintenanceResource(options.database.db);
    return options.database;
  }
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  try {
    stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  const cached = stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached?.db.isOpen) {
    assertOpenClawStateWriteAllowed({
      database: cached.db,
      databasePath: pathname,
      env,
      schemaReady: true,
    });
    observeOpenClawDatabaseMaintenanceResource(cached.db);
    if (deferredStateDatabases.has(cached.db)) {
      reconcileOpenClawStateSchemaPublication(options);
      if (readSqliteUserVersion(cached.db) === OPENCLAW_STATE_SCHEMA_VERSION) {
        deferredStateDatabases.delete(cached.db);
      }
    }
    return cached;
  }
  try {
    assertOpenClawStateDatabaseFreshOpenAllowed(options);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  let unpublished: OpenClawStateDatabase | undefined;
  try {
    unpublished = runWithOpenClawStateWriteAccess(
      { databasePath: pathname, busyTimeoutMs, env },
      "fresh state database open",
      () => {
        if (cached) {
          // A closed handle can leave Kysely and WAL helpers cached; clear both under access.
          stateDbCache.closeStaleCachedOpenClawStateDatabase(cached);
        }
        return (unpublished = openUnpublishedStateDatabase({
          pathname,
          env,
          busyTimeoutMs,
          lockFailureReporting,
          ensureSchema: (database) => ensureSchema(database, pathname, env, busyTimeoutMs),
          recordOpenFailure: recordOpenClawStateDatabaseOpenFailure,
        }));
      },
    );
  } catch (error) {
    if (lockFailureReporting === "report" || !isOpenClawStateWriteContentionError(error)) {
      stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    }
    if (!unpublished) {
      throw error;
    }
    const errors = stateDbCache.closeUnpublishedOpenClawStateDatabaseHandle(unpublished);
    if (errors.length > 0) {
      throw createSqliteLifecycleAggregateError(
        [error, ...errors],
        `Fresh OpenClaw state database open failed releasing access and closing its unpublished handle for ${pathname}.`,
        error,
      );
    }
    throw error;
  }
  const database = stateDbCache.publishOpenClawStateDatabase(unpublished);
  if (readSqliteUserVersion(database.db) < OPENCLAW_STATE_SCHEMA_VERSION) {
    deferredStateDatabases.add(database.db);
    reconcileOpenClawStateSchemaPublication(options);
  }
  return database;
}

/** Open or return a cached shared state database after schema and migration checks. */
export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  return openOpenClawStateDatabaseWithBusyTimeout(options);
}

/** The Gateway watcher also publishes without requiring a new physical database open. */
export function reconcileOpenClawStateSchemaPublication(
  options: OpenClawStateDatabaseOptions = {},
): StateSchemaPublicationBlocker | undefined {
  const pending = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (
      readSqliteUserVersion(db) >= OPENCLAW_STATE_SCHEMA_VERSION ||
      readStateSchemaContentVersion(db) < OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      return undefined;
    }
    return { blocker: readStateSchemaPublicationBlocker(db) };
  }, options);
  if (!pending || pending.blocker) {
    return pending?.blocker;
  }
  const pathname = resolveDatabasePath(options);
  try {
    return withStateSchemaFence({ databasePath: pathname }, () =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          // The advisory read may race a new update. Re-read every driver under the write lock.
          const blocker = readStateSchemaPublicationBlocker(db);
          if (blocker) {
            return blocker;
          }
          assertOpenClawStateDatabaseForMaintenance(db, { pathname });
          markCurrentStateSchemaVersion(db);
          return undefined;
        },
        options,
        { operationLabel: "state.schema.publish" },
      ),
    );
  } catch (error) {
    // Current content is ready for readers; a live Gateway owns optional publication.
    if (error instanceof StateSchemaMutationConflictError) {
      return undefined;
    }
    throw error;
  }
}

/** Run one operation through the shared owner without waiting synchronously on SQLite locks. */
export function runWithOpenClawStateBusyTimeout<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  busyTimeoutMs: number,
): T {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const existing = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  if (existing) {
    return runWithSqliteBusyTimeout(
      existing.db,
      normalizedTimeoutMs,
      () => {
        observeOpenClawDatabaseMaintenanceResource(existing.db);
        return operation(existing);
      },
      { lockFailureReporting: "suppress" },
    );
  }
  const opened = openOpenClawStateDatabaseWithBusyTimeout(options, normalizedTimeoutMs, "suppress");
  try {
    return runWithSqliteBusyTimeout(opened.db, normalizedTimeoutMs, () => operation(opened), {
      lockFailureReporting: "suppress",
    });
  } finally {
    if (opened.db.isOpen) {
      setSqliteBusyTimeout(opened.db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    }
  }
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const existing = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  return withSharedStateWriteCoordinator(
    {
      databasePath: existing?.path ?? resolveDatabasePath(options),
      existing: existing?.db,
      ...transactionOptions,
    },
    () => {
      let database = existing;
      let result: T;
      try {
        const acquired = options.database
          ? openOpenClawStateDatabase(options)
          : (database ?? openOpenClawStateDatabase(options));
        database = acquired;
        result = runCoordinatedStateTransaction(
          acquired.db,
          () => {
            assertOpenClawStateWriteAllowed({
              database: acquired.db,
              databasePath: acquired.path,
              env: options.env ?? process.env,
              schemaReady:
                !options.database && acquired === getOpenClawStateDatabaseIfOpen(options),
            });
            observeOpenClawDatabaseMaintenanceResource(acquired.db);
            return operation(acquired);
          },
          {
            busyTimeoutMs: transactionOptions.busyTimeoutMs ?? readSqliteBusyTimeout(acquired.db),
            databaseLabel: acquired.path,
            ...transactionOptions,
            operationLabel: transactionOptions.operationLabel ?? "state.write",
          },
        );
      } catch (error) {
        if (database) {
          stateDbCache.evictOpenClawStateDatabaseAfterCorruption(database, error);
        }
        throw error;
      }
      try {
        ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
      } catch {
        // The write already committed; permission hardening is best-effort here so
        // callers never retry an operation that is durable in SQLite.
      }
      return result;
    },
  );
}

/**
 * Return a shared state handle this process already holds open, if any.
 *
 * Read-only callers use this to avoid opening a connection per call; it never
 * creates, repairs, or registers a handle.
 */
function getOpenClawStateDatabaseIfOpen(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase | undefined {
  const cached = stateDbCache.getCachedOpenClawStateDatabase(resolveDatabasePath(options));
  return cached?.db.isOpen ? cached : undefined;
}

export {
  recordOpenClawStateDatabaseOpenFailure,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
  closeOpenClawStateDatabaseForTest,
  confirmOpenClawStateDatabaseIntegrity,
} from "./openclaw-state-db-cache.js";
