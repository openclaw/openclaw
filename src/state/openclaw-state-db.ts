import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { withStateDatabaseColdAdmission } from "../infra/gateway-state-owner.js";
import {
  normalizeSqliteNonNegativeInteger,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
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
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { needsOpenClawStateDatabaseSchemaRepair } from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  markCurrentStateSchemaVersion,
  resolveDatabasePath,
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
import {
  assertOpenClawStateWriteAllowed,
  assertOpenClawStateWriteAllowedAtPath,
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

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowed(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const env = options.env ?? process.env;
  stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(resolveDatabasePath(options), env);
}

const deferredStateDatabases = new WeakSet<DatabaseSync>();

function repairDoctorStateDatabase(
  options: OpenClawStateDatabaseOptions,
  scope: "doctor" | "indexes" | "readability",
): { changes: string[]; warnings: string[] } {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  if (scope === "readability") {
    // A writer close can checkpoint WAL and invalidate a generation-bound corruption refusal.
    assertOpenClawStateDatabaseFreshOpenAllowed(options);
  }
  return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () =>
    repairStateSchema(pathname, env, scope),
  );
}

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  return repairDoctorStateDatabase(options, "doctor");
}

/** Explicit Doctor maintenance before config readers encounter a quarantined index. */
export function repairOpenClawStateDatabaseIndexesForDoctor(
  options: OpenClawStateDatabaseOptions = {},
): { changes: string[]; warnings: string[] } {
  return repairDoctorStateDatabase(options, "indexes");
}

/** Repair known catalog damage and preserve orphan rows before Doctor backs up or loads state. */
export function repairOpenClawStateDatabaseReadabilityForDoctor(
  options: OpenClawStateDatabaseOptions = {},
): { changes: string[]; warnings: string[] } {
  return repairDoctorStateDatabase(options, "readability");
}

/** Prepare schema and retire resources only when the admitted operation actually repairs it. */
export async function prepareOpenClawStateDatabaseSchema(
  options: OpenClawStateDatabaseOptions = {},
  mode: "automatic" | "doctor-preparation" | "doctor" = "automatic",
): Promise<{
  changes: string[];
  warnings: string[];
}> {
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
        assertOpenClawStateDatabaseFreshOpenAllowed(options);
      } catch {
        // The full repair must clear quarantine before dependent readers can proceed.
        needsRepair = true;
      }
    }
    return needsRepair || needsOpenClawStateDatabaseSchemaRepair(pathname, scope)
      ? withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () => {
          repairStarted = true;
          return repairStateSchema(pathname, env, scope);
        })
      : { changes: [], warnings: [] };
  } finally {
    // Readiness checks borrow the live generation; only admitted repair retires it.
    if (repairStarted) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
  }
}

/** Bootstrap fresh/native-only state canonically before startup checkpoint access. */
export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions & { atomic?: boolean } = {},
): T {
  return withOpenClawStateStartupCheckpointConnection(callback, options, ensureSchema);
}

/** Complete native bootstrap without migrating mature shared state. */
export function initializeNativeOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): void {
  initializeNativeOpenClawStateConnection(options, (db, pathname, env, initialization) =>
    ensureSchema(db, pathname, env, initialization, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, true),
  );
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): Promise<OpenClawStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  isExistingOpenClawStateSchema(pathname);
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
    if (isExistingOpenClawStateSchema(pathname, db)) {
      assertExistingOpenClawStateRuntimeSchema(db, pathname);
    }
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
      reclaimFreePages: createSqliteWalReclamationResult,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close: () => connection.close(),
    },
  };
}

/** Open or return a cached shared state database after schema and migration checks. */

function openOpenClawStateDatabaseWithBusyTimeout(
  options: OpenClawStateDatabaseOptions = {},
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  lockFailureReporting: SqliteLockFailureReporting = "report",
  remainingColdAdmissionTimeout?: () => number,
): OpenClawStateDatabase {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  const env = options.env ?? process.env;
  if (options.database) {
    assertStateDatabaseSchemaAdmission(options.database);
    assertOpenClawStateWriteAllowed({
      database: options.database.db,
      databasePath: options.database.path,
      env,
    });
    observeOpenClawDatabaseMaintenanceResource(options.database.db);
    stateDbCache.touchStateDatabase(options.database);
    return options.database;
  }
  const pathname = resolveDatabasePath(options);
  const existingSchema = isExistingOpenClawStateSchema(pathname);
  const cached = stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached?.db.isOpen) {
    // A refused cache borrow did not open or damage the database. Failure owners
    // publish their own retirement events; caller admission must not retire it.
    stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
    assertStateDatabaseSchemaAdmission(cached);
    assertOpenClawStateWriteAllowed({
      database: cached.db,
      databasePath: pathname,
      env,
      schemaReady: true,
    });
    observeOpenClawDatabaseMaintenanceResource(cached.db);
    if (!existingSchema && deferredStateDatabases.has(cached.db)) {
      reconcileOpenClawStateSchemaPublication(options);
      if (readSqliteUserVersion(cached.db) === OPENCLAW_STATE_SCHEMA_VERSION) {
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
      assertOpenClawStateDatabaseFreshOpenAllowed(options);
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
    setSqliteBusyTimeout(unpublished.db, busyTimeoutMs);
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
    if (!existingSchema && readSqliteUserVersion(database.db) < OPENCLAW_STATE_SCHEMA_VERSION) {
      deferredStateDatabases.add(database.db);
      reconcileOpenClawStateSchemaPublication(options);
    }
    return database;
  } catch (error) {
    // Failed publication can retain this cached handle before the caller can
    // restore its temporary busy timeout. Ordinary later writes keep their policy.
    if (database.db.isOpen) {
      setSqliteBusyTimeout(database.db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    }
    throw error;
  }
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
  if (isExistingOpenClawStateSchema(options.database?.path ?? resolveDatabasePath(options))) {
    return undefined;
  }
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
    return withStateDatabaseSchemaMaintenance({ databasePath: pathname }, () =>
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
    assertStateDatabaseSchemaAdmission(existing);
    return runWithSqliteBusyTimeout(
      existing.db,
      normalizedTimeoutMs,
      () => {
        observeOpenClawDatabaseMaintenanceResource(existing.db);
        stateDbCache.touchStateDatabase(existing);
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
  if (existing) {
    isExistingOpenClawStateSchema(existing.path, existing.db);
  }
  let database = existing;
  let callbackEntered = false;
  let committed: { database: OpenClawStateDatabase; value: T };
  const execute = (remaining?: () => number) => {
    const acquired = options.database
      ? openOpenClawStateDatabase(options)
      : (database ??
        openOpenClawStateDatabaseWithBusyTimeout(
          options,
          OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          "report",
          remaining,
        ));
    database = acquired;
    const value = runManagedStateTransaction(
      acquired.db,
      () => {
        assertStateDatabaseSchemaAdmission(acquired);
        assertOpenClawStateWriteAllowed({
          database: acquired.db,
          databasePath: acquired.path,
          env: options.env ?? process.env,
          schemaReady: !options.database && acquired === getOpenClawStateDatabaseIfOpen(options),
        });
        observeOpenClawDatabaseMaintenanceResource(acquired.db);
        callbackEntered = true;
        return operation(acquired);
      },
      {
        databaseLabel: acquired.path,
        ...transactionOptions,
        ...(remaining ? { busyTimeoutMs: remaining() } : {}),
        operationLabel: transactionOptions.operationLabel ?? "state.write",
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
    const location = database.db.location();
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
    assertExistingOpenClawStateRuntimeSchema(database.db, database.path);
  }
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
