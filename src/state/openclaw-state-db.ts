import { existsSync } from "node:fs";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import {
  assertStateDatabaseAccessAllowed,
  withStateDatabaseColdAdmission,
} from "../infra/gateway-state-owner.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  normalizeSqliteNonNegativeInteger,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { captureSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import {
  getAdmittedSqliteSchemaFacts,
  invalidateSqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import {
  openSqliteReadOnlyDatabase,
  prepareSqliteReadOnlyLocation,
} from "../infra/sqlite-snapshot-source.js";
import {
  assertTransactionUsable,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../infra/state-database-maintenance.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import { getStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openClawStateDatabaseCache as stateDbCache,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import { assertStateFileSnapshotAllowed, isStatePostgres } from "./openclaw-state-db-engine.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { needsOpenClawStateDatabaseSchemaRepair } from "./openclaw-state-db-fast-path.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  markCurrentStateSchemaVersion,
} from "./openclaw-state-db-maintenance.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { repairStateSchema } from "./openclaw-state-db-repair.js";
import {
  assertOpenClawStateSchemaRepairAllowed,
  isExistingOpenClawStateSchema,
  recordExistingOpenClawStateSchemaDatabase,
} from "./openclaw-state-db-schema-policy.js";
import { ensureOpenClawStateRuntimeSchema as ensureSchema } from "./openclaw-state-db-schema-runtime.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  initializeNativeOpenClawStateConnection,
  withOpenClawStateStartupCheckpointConnection,
} from "./openclaw-state-db-startup-checkpoint.js";
import { runManagedStateTransaction } from "./openclaw-state-db-transaction.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "./openclaw-state-ownership-preflight.js";
import {
  assertOpenClawStateWriteAllowed,
  isOpenClawStateWriteContentionError,
} from "./openclaw-state-ownership.js";
import {
  readStateSchemaPublicationBlocker,
  type StateSchemaPublicationBlocker,
} from "./openclaw-state-schema-publication.js";

export { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
export type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
export { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
export { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
export { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db-schema-discovery.js";

const deferredStateDatabases = new WeakSet<EngineConnection>();

function readPublishedStateSchemaVersion(database: EngineConnection): number {
  const admitted = getStateSchemaVersionAdmission(database);
  if (admitted) {
    return admitted.userVersion;
  }
  if (isPostgresSqlConnection(database)) {
    requireNativeDatabaseFile("postgres", "repair");
  }
  return readSqliteUserVersion(database);
}

function repairDoctorStateDatabase(
  options: OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" },
  scope: "doctor" | "indexes" | "readability" | "version",
): { changes: string[]; warnings: string[] } {
  if (isStatePostgres()) {
    // The engine owner admits PostgreSQL's catalog; SQLite file repairs do not apply.
    openOpenClawStateDatabase(options);
    return { changes: [], warnings: [] };
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  if (scope === "readability") {
    // A writer close can checkpoint WAL and invalidate a generation-bound corruption refusal.
    stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  }
  return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () =>
    repairStateSchema(pathname, env, scope, options.integrityCheck),
  );
}

export function repairOpenClawStateDatabaseSchema(
  options: OpenClawStateDatabaseOptions & {
    versionMigrationOnly?: boolean;
    integrityCheck?: "quick" | "full";
  } = {},
): {
  changes: string[];
  warnings: string[];
} {
  return repairDoctorStateDatabase(options, options.versionMigrationOnly ? "version" : "doctor");
}

/** Explicit Doctor maintenance before config readers encounter a quarantined index. */
export function repairOpenClawStateDatabaseIndexesForDoctor(
  options: OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" } = {},
): { changes: string[]; warnings: string[] } {
  return repairDoctorStateDatabase(
    { ...options, integrityCheck: options.integrityCheck ?? "full" },
    "indexes",
  );
}

/** Repair known catalog damage and preserve orphan rows before Doctor backs up or loads state. */
export function repairOpenClawStateDatabaseReadabilityForDoctor(
  options: OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" } = {},
): { changes: string[]; warnings: string[] } {
  return repairDoctorStateDatabase(options, "readability");
}

/** Prepare schema and retire resources only when the admitted operation actually repairs it. */
export async function prepareOpenClawStateDatabaseSchema(
  options: OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" } = {},
  mode: "automatic" | "doctor-preparation" | "doctor" = "automatic",
): Promise<{
  changes: string[];
  warnings: string[];
}> {
  if (isStatePostgres()) {
    openOpenClawStateDatabase(options);
    return { changes: [], warnings: [] };
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }

  const scope = mode === "automatic" ? "automatic" : "doctor";
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: pathname,
    env,
    recoverOrphanedSidecars: false,
    ...(scope === "doctor"
      ? { openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission }
      : {}),
  });
  let repairStarted = false;
  try {
    let needsRepair = mode === "doctor";
    if (mode === "doctor-preparation") {
      try {
        stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
      } catch {
        // The full repair must clear quarantine before dependent readers can proceed.
        needsRepair = true;
      }
    }
    if (
      !needsRepair &&
      !needsOpenClawStateDatabaseSchemaRepair(pathname, scope, options.integrityCheck)
    ) {
      return { changes: [], warnings: [] };
    }
    repairStarted = true;
    // Retire prior writers and publish their native-close receipts before the
    // private repair handle validates its source and acquires exclusive custody.
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () =>
      repairStateSchema(pathname, env, scope, options.integrityCheck),
    );
  } finally {
    // Readiness checks borrow the live generation; only admitted repair retires it.
    if (repairStarted) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
  }
}

/** Bootstrap fresh/native-only state canonically before startup checkpoint access. */
export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: EngineConnection) => T,
  options: OpenClawStateDatabaseOptions & {
    atomic?: boolean;
    sealOnClose?: boolean;
    singleStatement?: true;
  } = {},
): T {
  assertOpenClawStateSchemaRepairAllowed(resolveDatabasePath(options));
  if (isStatePostgres()) {
    return withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase(options);
      try {
        return runOpenClawStateWriteTransaction(({ db }) => callback(db), { ...options, database });
      } finally {
        if (options.sealOnClose) {
          stateDbCache.closeOpenClawStateDatabaseByPath(database.path);
        }
      }
    });
  }
  const database = getOpenClawStateDatabaseIfOpen(options);
  if (database && isPostgresSqlConnection(database.db)) {
    requireNativeDatabaseFile("postgres", "repair");
  }
  if (
    database &&
    getAdmittedSqliteSchemaFacts(database.db)?.userVersion === OPENCLAW_STATE_SCHEMA_VERSION
  ) {
    // Lease rows use the admitted owner; legacy/native bootstrap still needs its
    // separate integrity-proven connection before the full schema can be opened.
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (isPostgresSqlConnection(db)) {
          requireNativeDatabaseFile("postgres", "repair");
        }
        return callback(db);
      },
      { env: options.env, path: database.path },
      {
        operationLabel: "state.startup-checkpoint.write",
        singleStatement: options.singleStatement,
      },
    );
    if (options.sealOnClose) {
      stateDbCache.closeOpenClawStateDatabaseByPath(database.path);
    }
    return result;
  }
  return withOpenClawStateStartupCheckpointConnection(callback, options, ensureSchema);
}

/** Complete native bootstrap without migrating mature shared state. */
export function initializeNativeOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (isStatePostgres()) {
    requireNativeDatabaseFile("postgres", "repair");
  }
  initializeNativeOpenClawStateConnection(options, (db, pathname, env, initialization) =>
    ensureSchema(db, pathname, env, initialization, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, true),
  );
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions & {
    requireCanonicalSchema?: boolean;
    integrityCheck?: "quick" | "full";
  } = {},
): Promise<OpenClawStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  isExistingOpenClawStateSchema(pathname);
  if (!existsSync(pathname)) {
    return undefined;
  }
  stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
    pathname,
    options.env ?? process.env,
  );
  const prepared = isStatePostgres() ? pathname : await prepareSqliteReadOnlyLocation(pathname);
  const connection = openOpenClawStateReadConnection(pathname, prepared);
  const { db } = connection.database;
  try {
    if (isPostgresSqlConnection(db)) {
      assertSupportedStateSchemaVersion(db, pathname);
    } else if (isExistingOpenClawStateSchema(pathname, db) || options.requireCanonicalSchema) {
      assertExistingOpenClawStateRuntimeSchema(db, pathname);
    } else {
      assertSupportedStateSchemaVersion(db, pathname);
      assertSqliteIntegrity(db, pathname, { check: options.integrityCheck });
      if (readStateSchemaContentVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
        assertOpenClawStateDatabaseForMaintenance(db, { pathname });
      }
    }
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Preserve the verification failure that explains why the database was refused.
    }
    throw error;
  }
  return readOnlyStateDatabase(connection.database, connection.close);
}

function readOnlyStateDatabase(
  database: Pick<OpenClawStateDatabase, "db" | "path">,
  close: () => boolean,
): OpenClawStateDatabase {
  return {
    ...database,
    walMaintenance: {
      checkpoint: () => false,
      stop: async () => {},
      reclaimFreePages: createSqliteWalReclamationResult,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close,
    },
  };
}

function openOpenClawStateDatabaseWithBusyTimeout(
  options: OpenClawStateDatabaseOptions = {},
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  lockFailureReporting: SqliteLockFailureReporting = "report",
  remainingColdAdmissionTimeout?: () => number,
): OpenClawStateDatabase {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const env = options.env ?? process.env;
  const pathname = options.database?.path ?? resolveDatabasePath(options);
  if (isArtifactPreservingStateRead("agent", pathname)) {
    assertStateFileSnapshotAllowed();
    stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    const db = openSqliteReadOnlyDatabase(pathname, { timeout: busyTimeoutMs });
    assertSupportedStateSchemaVersion(db, pathname);
    return readOnlyStateDatabase({ db, path: pathname }, () => {
      db.close();
      return true;
    });
  }
  const existingSchema = !options.database && isExistingOpenClawStateSchema(pathname);
  const cached = options.database ?? stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached && (options.database || cached.db.isOpen)) {
    if (!options.database) {
      // A refused cache borrow did not open or damage the database. Failure owners
      // publish their own retirement events; caller admission must not retire it.
      stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
    }
    assertStateDatabaseSchemaAdmission(cached);
    assertOpenClawStateWriteAllowed({
      database: cached.db,
      databasePath: pathname,
      env,
      schemaReady: stateDbCache.isOpenClawStateDatabaseSchemaReady(cached),
    });
    observeOpenClawDatabaseMaintenanceResource(cached.db);
    if (options.database) {
      stateDbCache.touchStateDatabase(cached);
    } else if (!existingSchema && deferredStateDatabases.has(cached.db)) {
      reconcileOpenClawStateSchemaPublication(options);
      if (
        getStateSchemaVersionAdmission(cached.db)?.userVersion === OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        deferredStateDatabases.delete(cached.db);
      }
    }
    return cached;
  }
  let unpublished: OpenClawStateDatabase | undefined;
  try {
    const open = (remaining: () => number) => {
      getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
      stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
      stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
      if (cached) {
        // A closed handle can leave Kysely and WAL helpers cached.
        stateDbCache.closeStaleCachedOpenClawStateDatabase(cached);
      }
      return openUnpublishedStateDatabase({
        pathname,
        env,
        busyTimeoutMs: remaining(),
        lockFailureReporting,
        existingSchema,
        initializationAgentPaths: options.initializationAgentPaths,
        ensureSchema: (database, initialization) =>
          ensureSchema(database, pathname, env, initialization, remaining()),
        recordOpenFailure: recordOpenClawStateDatabaseOpenFailure,
      });
    };
    unpublished = remainingColdAdmissionTimeout
      ? open(remainingColdAdmissionTimeout)
      : withStateDatabaseColdAdmission({ databasePath: pathname, busyTimeoutMs }, open);
    if (!isPostgresSqlConnection(unpublished.db)) {
      setSqliteBusyTimeout(unpublished.db, busyTimeoutMs);
    }
  } catch (error) {
    if (lockFailureReporting === "report" || !isOpenClawStateWriteContentionError(error)) {
      stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    }
    if (unpublished) {
      const errors = stateDbCache.closeUnpublishedOpenClawStateDatabaseHandle(unpublished);
      if (errors.length > 0) {
        throw createSqliteLifecycleAggregateError(
          [error, ...errors],
          `Fresh OpenClaw state database open failed releasing access and closing its unpublished handle for ${pathname}.`,
          error,
        );
      }
    }
    throw error;
  }
  if (existingSchema) {
    recordExistingOpenClawStateSchemaDatabase(unpublished.db, pathname);
  }
  const database = stateDbCache.publishOpenClawStateDatabase(unpublished, env);
  try {
    if (
      !existingSchema &&
      readPublishedStateSchemaVersion(database.db) < OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      deferredStateDatabases.add(database.db);
      reconcileOpenClawStateSchemaPublication(options);
    }
    return database;
  } catch (error) {
    // Failed publication can retain this cached handle before the caller can
    // restore its temporary busy timeout. Ordinary later writes keep their policy.
    if (database.db.isOpen && !isPostgresSqlConnection(database.db)) {
      setSqliteBusyTimeout(database.db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    }
    throw error;
  }
}

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  return openOpenClawStateDatabaseWithBusyTimeout(options);
}

/** The Gateway watcher also publishes without requiring a new physical database open. */
export function reconcileOpenClawStateSchemaPublication(
  options: OpenClawStateDatabaseOptions = {},
): StateSchemaPublicationBlocker | undefined {
  if (isExistingOpenClawStateSchema(options.database?.path ?? resolveDatabasePath(options))) {
    return undefined;
  }
  const pending = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (
      readPublishedStateSchemaVersion(db) >= OPENCLAW_STATE_SCHEMA_VERSION ||
      readStateSchemaContentVersion(db) < OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      return undefined;
    }
    if (isPostgresSqlConnection(db)) {
      requireNativeDatabaseFile("postgres", "repair");
    }
    return { blocker: readStateSchemaPublicationBlocker(db) };
  }, options);
  if (!pending || pending.blocker) {
    return pending?.blocker;
  }
  const pathname = resolveDatabasePath(options);
  try {
    return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          if (isPostgresSqlConnection(db)) {
            requireNativeDatabaseFile("postgres", "repair");
          }
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
  if (
    isArtifactPreservingStateRead("agent", options.database?.path ?? resolveDatabasePath(options))
  ) {
    return operation(openOpenClawStateDatabaseWithBusyTimeout(options, busyTimeoutMs));
  }
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const existing = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  if (existing) {
    assertStateDatabaseSchemaAdmission(existing);
    const execute = () => {
      observeOpenClawDatabaseMaintenanceResource(existing.db);
      stateDbCache.touchStateDatabase(existing);
      return operation(existing);
    };
    if (isPostgresSqlConnection(existing.db)) {
      return execute();
    }
    return runWithSqliteBusyTimeout(existing.db, normalizedTimeoutMs, execute, {
      lockFailureReporting: "suppress",
    });
  }
  const opened = openOpenClawStateDatabaseWithBusyTimeout(options, normalizedTimeoutMs, "suppress");
  try {
    if (isPostgresSqlConnection(opened.db)) {
      return operation(opened);
    }
    return runWithSqliteBusyTimeout(opened.db, normalizedTimeoutMs, () => operation(opened), {
      lockFailureReporting: "suppress",
    });
  } finally {
    if (opened.db.isOpen && !isPostgresSqlConnection(opened.db)) {
      setSqliteBusyTimeout(opened.db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    }
  }
}

/** Run an admitted shared-state write; complete single statements may use autocommit. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "beginLockFailureReporting" | "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > & { singleStatement?: true } = {},
): T {
  if (
    isArtifactPreservingStateRead("agent", options.database?.path ?? resolveDatabasePath(options))
  ) {
    throw new Error("Programming error: shared-state write during artifact-preserving inspection.");
  }
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const existing = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  if (existing) {
    isExistingOpenClawStateSchema(existing.path, existing.db);
    if (options.database) {
      assertStateDatabaseAccessAllowed(existing.path);
    }
  }
  let database = existing;
  let callbackEntered = false;
  let committed: { database: OpenClawStateDatabase; value: T };
  const execute = (remaining?: () => number) => {
    // A supplied writer is already selected; its authoritative rows are read after BEGIN.
    const acquired =
      database ??
      openOpenClawStateDatabaseWithBusyTimeout(
        options,
        OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        "report",
        remaining,
      );
    database = acquired;
    const value = runManagedStateTransaction(
      acquired.db,
      () => {
        assertStateDatabaseSchemaAdmission(acquired);
        // Recheck cached-path admission after a cold-open contention retry.
        if (!options.database) {
          getOpenClawStateDatabaseIfOpen(options);
        }
        assertOpenClawStateWriteAllowed({
          database: acquired.db,
          databasePath: acquired.path,
          env: options.env ?? process.env,
          schemaReady: stateDbCache.isOpenClawStateDatabaseSchemaReady(acquired),
        });
        observeOpenClawDatabaseMaintenanceResource(acquired.db);
        if (options.database) {
          stateDbCache.touchStateDatabase(acquired);
        }
        callbackEntered = true;
        return operation(acquired);
      },
      {
        databaseLabel: acquired.path,
        ...transactionOptions,
        ...(remaining ? { busyTimeoutMs: remaining() } : {}),
        operationLabel:
          transactionOptions.operationLabel ??
          captureSqliteReaderOwner()?.operation ??
          "state.write",
      },
    );
    return { database: acquired, value };
  };
  try {
    committed = existing
      ? execute()
      : withStateDatabaseColdAdmission(
          {
            databasePath: resolveDatabasePath(options),
            busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            canRetry() {
              if (
                callbackEntered ||
                (database && (!database.db.isOpen || database.db.isTransaction))
              ) {
                return false;
              }
              if (database) {
                assertTransactionUsable(database.db);
                // A schema owner interrupted first admission. Reopen after it settles;
                // the schema admitted before the wait no longer describes that handoff.
                if (!isPostgresSqlConnection(database.db)) {
                  invalidateSqliteSchemaFacts(database.db);
                }
                stateDbCache.closeOpenClawStateDatabaseByPath(database.path);
                database = undefined;
              }
              return true;
            },
          },
          execute,
        );
  } catch (error) {
    if (database) {
      stateDbCache.evictOpenClawStateDatabaseAfterCorruption(database, error);
    }
    throw error;
  }
  try {
    if (!isExistingOpenClawStateSchema(committed.database.path, committed.database.db)) {
      ensureOpenClawStatePermissions(committed.database.path, options.env ?? process.env);
    }
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return committed.value;
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
  const pathname = resolveDatabasePath(options);
  isExistingOpenClawStateSchema(pathname);
  const cached = stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached?.db.isOpen) {
    isExistingOpenClawStateSchema(cached.path, cached.db);
  }
  return cached?.db.isOpen ? cached : undefined;
}

function assertStateDatabaseSchemaAdmission(database: OpenClawStateDatabase): void {
  if (isExistingOpenClawStateSchema(database.path, database.db)) {
    const location = readTrackedStateDatabaseIdentity(database.db)?.canonicalPath;
    if (!location) {
      throw new Error(
        "Existing shared-state schema admission requires a filesystem-backed database.",
      );
    }
    if (!isExistingOpenClawStateSchema(location, database.db)) {
      throw new Error(
        "Existing shared-state schema admission requires its selected physical database.",
      );
    }
    if (isPostgresSqlConnection(database.db)) {
      assertSupportedStateSchemaVersion(database.db, database.path);
      return;
    }
    assertExistingOpenClawStateRuntimeSchema(database.db, database.path);
  }
}

export {
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db-cache.js";
