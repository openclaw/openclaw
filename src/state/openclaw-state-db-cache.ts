import { existsSync } from "node:fs";
import {
  assertStateDatabaseAccessAllowed,
  assertStateDatabaseReadAllowed,
} from "../infra/gateway-state-owner.js";
import { registerNodeSqliteKyselyQueryErrorHandler } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  isSqliteCorruptionError,
  isSqliteLockError,
  sqlitePrimaryResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { readGlobalSingleton, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import {
  createOpenClawStateDatabaseAsyncLifecycle,
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawDatabaseMaintenanceScope,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  assertStateDatabaseBorrowersReleased,
  createStateDatabaseRetainer,
  type StateDatabaseBorrowers,
} from "./openclaw-state-db-borrow.js";
import { createStateDatabaseCacheAdmission } from "./openclaw-state-db-cache.admission.js";
import { createStateDatabaseIdleRetirement } from "./openclaw-state-db-cache.idle.js";
import type { StateDatabaseLifecycle } from "./openclaw-state-db-cache.types.js";
import { createStateDatabaseWalOwner } from "./openclaw-state-db-cache.wal.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseCloseOptions,
  OpenClawStateDatabaseLifecycleEvent,
  StateDatabaseHandle,
} from "./openclaw-state-db-contract.js";
import {
  closeStateDatabaseHandle,
  readTrackedStateDatabaseIdentity,
} from "./openclaw-state-db-handle.js";
import { invalidateOpenClawStateRuntimeIntegrity } from "./openclaw-state-db-integrity-admission.js";
import { assertExistingOpenClawStateSchemaCacheAdmission } from "./openclaw-state-db-schema-policy.js";
import { openClawStateSnapshotOwners } from "./openclaw-state-db-snapshot-owner.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const STATE_DATABASE_LIFECYCLE_KEY = Symbol.for("openclaw.stateDatabaseLifecycle");
const stateDatabaseLifecycle = resolveGlobalSingleton<StateDatabaseLifecycle>(
  STATE_DATABASE_LIFECYCLE_KEY,
  () => ({
    cachedDatabases: new Map<string, OpenClawStateDatabase>(),
    retainedDatabaseHandles: new Map<EngineConnection, StateDatabaseHandle>(),
    idleTimers: new WeakMap(),
    idleReferences: new WeakMap(),
    unregisterRetainedExitClose: undefined,
    databaseIdentities: new WeakMap<EngineConnection, DatabasePathIdentity>(),
    borrowers: new WeakMap<EngineConnection, StateDatabaseBorrowers>(),
    databaseLifecycleListeners: new Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>(),
    terminalOpenLatch: createSqliteTerminalOpenLatch({
      closeByPath: (pathname, error) => cacheAdmission.closeTerminalFailure(pathname, error),
    }),
    asyncResources: createOpenClawStateDatabaseAsyncLifecycle(),
  }),
  () => closeOpenClawStateDatabaseAsync(),
  "shared-state",
);
const {
  cachedDatabases,
  retainedDatabaseHandles,
  idleTimers,
  idleReferences,
  databaseIdentities,
  borrowers,
  databaseLifecycleListeners,
  terminalOpenLatch,
  asyncResources,
} = stateDatabaseLifecycle;

const { touch: touchStateDatabase, retain: retainOpenClawStateDatabaseForIdle } =
  createStateDatabaseIdleRetirement(stateDatabaseLifecycle, retireOpenClawStateDatabaseHandle);
const {
  register: registerStateDatabaseWalAdmission,
  readHealth: readOpenClawStateWalHealth,
  ownRetirement: ownStateDatabaseRetirement,
  stop: stopOpenClawStateDatabaseMaintenance,
} = createStateDatabaseWalOwner(
  stateDatabaseLifecycle,
  retainOpenClawStateDatabaseForIdle,
  requireOpenClawStateDatabaseIdentity,
);
export { readOpenClawStateWalHealth, retainOpenClawStateDatabaseForIdle };

function notifyOpenClawStateDatabaseLifecycle(event: OpenClawStateDatabaseLifecycleEvent): void {
  const notification =
    event.kind === "open-error"
      ? { ...event, identity: event.identity ?? asyncResources.knownIdentity(event.path) }
      : event;
  for (const listener of databaseLifecycleListeners) {
    listener(notification);
  }
}

function notifyOpenClawStateDatabaseClosed(database: StateDatabaseHandle): void {
  notifyOpenClawStateDatabaseLifecycle({
    kind: "closed",
    path: database.path,
    identity: requireOpenClawStateDatabaseIdentity(database),
  });
}

export function requireOpenClawStateDatabaseIdentity(
  database: Pick<StateDatabaseHandle, "db">,
): DatabasePathIdentity {
  const identity = databaseIdentities.get(database.db);
  if (!identity) {
    throw new Error("Published shared-state owner has no recorded database identity");
  }
  return identity;
}

const cacheAdmission = createStateDatabaseCacheAdmission({
  cachedDatabases,
  evict: evictCachedOpenClawStateDatabase,
  invalidate: (pathname) => asyncResources.invalidate(pathname),
  notifyTerminalFailure: (pathname, error) =>
    notifyOpenClawStateDatabaseLifecycle({
      kind: "terminal-failure",
      path: pathname,
      error,
      identity: asyncResources.knownIdentity(pathname),
    }),
});

export function registerOpenClawStateDatabaseLifecycleListener(
  listener: (event: OpenClawStateDatabaseLifecycleEvent) => void,
): () => void {
  databaseLifecycleListeners.add(listener);
  for (const database of cachedDatabases.values()) {
    if (database.db.isOpen) {
      listener({
        kind: "opened",
        database,
        identity: requireOpenClawStateDatabaseIdentity(database),
      });
    }
  }
  return () => databaseLifecycleListeners.delete(listener);
}

/** Invalidate path-scoped projections on non-open database lifecycle events. */
export function registerOpenClawStatePathCacheInvalidation<Key, Value extends { path: string }>(
  cache: Map<Key, Value>,
): () => void {
  return registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened") {
      for (const [key, value] of cache) {
        if (value.path === (event.identity?.canonicalPath ?? event.path)) {
          cache.delete(key);
        }
      }
    }
  });
}

function retainStateDatabaseClose(database: StateDatabaseHandle): void {
  retainedDatabaseHandles.set(database.db, database);
  stateDatabaseLifecycle.unregisterRetainedExitClose ??= registerSqliteCacheExitClose(
    closeOpenClawStateDatabase,
  );
}

function ownMaintenanceStateDatabaseHandle(database: StateDatabaseHandle): void {
  getOpenClawDatabaseMaintenanceScope()?.own(database.db, "shared-handles", async () => {
    const closingScope = getOpenClawDatabaseMaintenanceScope();
    if (!closingScope || !isOpenClawDatabaseMaintenanceResourceOwned(database.db, closingScope)) {
      return;
    }
    if (
      cachedDatabases.get(database.path) === database ||
      retainedDatabaseHandles.get(database.db) === database
    ) {
      await database.walMaintenance?.stop();
      if (
        isOpenClawDatabaseMaintenanceResourceOwned(database.db, closingScope) &&
        (cachedDatabases.get(database.path) === database ||
          retainedDatabaseHandles.get(database.db) === database)
      ) {
        retireOpenClawStateDatabaseHandle(database, false);
      }
    }
  });
}

function closeUnpublishedOpenClawStateDatabaseHandle(database: StateDatabaseHandle): unknown[] {
  const errors = closeOpenClawStateDatabaseHandle(database);
  if (retainedDatabaseHandles.get(database.db) === database) {
    ownMaintenanceStateDatabaseHandle(database);
  }
  return errors;
}

/** Retain one exact canonical native owner; only the final reference retires its handle. */
export const {
  retain: retainOpenClawStateDatabase,
  borrowForRead: borrowOpenClawStateDatabaseForAsyncRead,
  retainForIndependentRead: retainOpenClawStateDatabaseForIndependentRead,
} = createStateDatabaseRetainer(stateDatabaseLifecycle, {
  assertOpen(pathname, ownership) {
    assertOpenClawStateDatabaseOpenAllowed(pathname, ownership);
    assertExistingOpenClawStateSchemaCacheAdmission(pathname, stateDatabaseLifecycle);
  },
  capture: (pathname) => asyncResources.capture(pathname),
  retire: retireOpenClawStateDatabaseHandle,
  retainFailed: retainStateDatabaseClose,
  ownRetirement: ownStateDatabaseRetirement,
  touch: touchStateDatabase,
});

/** Close both physical-handle owners while retaining every cleanup failure. */
function closeOpenClawStateDatabaseHandle(
  database: StateDatabaseHandle,
  options?: Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0],
): unknown[] {
  clearTimeout(idleTimers.get(database.db));
  idleTimers.delete(database.db);
  try {
    assertStateDatabaseBorrowersReleased(borrowers.get(database.db), database.path);
  } catch (error) {
    const owner = borrowers.get(database.db);
    if (owner) {
      owner.retiring = true;
      // Deferred native cleanup keeps this exact request, not the last read pin's scope.
      owner.retirement = {
        ordinary: true,
        isCurrent: () => true,
        retire: () => {
          throwSqliteLifecycleErrors(
            closeOpenClawStateDatabaseHandle(database, options),
            `OpenClaw state database cleanup failed for ${database.path}.`,
          );
          owner.cleanupComplete = true;
          borrowers.delete(database.db);
        },
      };
    }
    retainStateDatabaseClose(database);
    return [error];
  }
  idleReferences.delete(database.db);
  openClawStateSnapshotOwners.release(database.db);
  const { errors, cleanupPending } = closeStateDatabaseHandle(database, options);
  if (database.db.isOpen || cleanupPending) {
    retainStateDatabaseClose(database);
  } else {
    retainedDatabaseHandles.delete(database.db);
  }
  // A failed native close retains physical custody, never a successful cache hit.
  if (cachedDatabases.get(database.path)?.db === database.db) {
    cachedDatabases.delete(database.path);
  }
  if (retainedDatabaseHandles.size === 0) {
    stateDatabaseLifecycle.unregisterRetainedExitClose?.();
    stateDatabaseLifecycle.unregisterRetainedExitClose = undefined;
  }
  return errors;
}

function evictCachedOpenClawStateDatabase(database: OpenClawStateDatabase): boolean {
  if (!isPostgresSqlConnection(database.db)) {
    invalidateOpenClawStateRuntimeIntegrity(database.db);
  }
  if (cachedDatabases.get(database.path) !== database) {
    return false;
  }
  // Remove ownership before cleanup. A poisoned native handle can reject close,
  // but it must never remain discoverable as the process-wide shared handle.
  asyncResources.invalidate(database.path);
  cachedDatabases.delete(database.path);
  notifyOpenClawStateDatabaseClosed(database);
  // A poisoned cache owner is not the database lifecycle owner. PASSIVE avoids
  // waiting on readers or resetting recovery frames another connection needs.
  closeOpenClawStateDatabaseHandle(database, { checkpointMode: "PASSIVE" });
  return true;
}

/** Evict an exact cached shared-state owner after a proven corruption read. */
function evictOpenClawStateDatabaseAfterCorruption(
  database: OpenClawStateDatabase,
  error: unknown,
): boolean {
  return isSqliteCorruptionError(error) && evictCachedOpenClawStateDatabase(database);
}

/** Publish a fully opened handle and bind query corruption to its exact cache owner. */
function publishOpenClawStateDatabase(
  database: OpenClawStateDatabase,
  env: NodeJS.ProcessEnv,
): OpenClawStateDatabase {
  const { db, path: pathname } = database;
  const { identity, admission } = asyncResources.publish(pathname);
  // Lifecycle settlement retains this projection after native disposal clears its identity.
  databaseIdentities.set(db, readTrackedStateDatabaseIdentity(db) ?? identity);
  cachedDatabases.set(pathname, database);
  registerStateDatabaseWalAdmission(database, identity, admission, env);
  touchStateDatabase(database);
  openClawStateSnapshotOwners.register(database, () => cachedDatabases.get(pathname));
  ownMaintenanceStateDatabaseHandle(database);
  notifyOpenClawStateDatabaseLifecycle({ kind: "opened", database, identity });
  if (!isPostgresSqlConnection(db)) {
    registerNodeSqliteKyselyQueryErrorHandler(db, (error) => {
      // Write transactions own rollback and evict at their outer boundary.
      if (!db.isTransaction && isSqliteCorruptionError(error)) {
        evictCachedOpenClawStateDatabase(database);
      }
    });
  }
  terminalOpenLatch.clear(pathname);
  return database;
}

/** Looking up an admitted handle does not consume schema or row facts. */
function getCachedOpenClawStateDatabase(
  pathname: string,
  options?: { readOnly: true },
): OpenClawStateDatabase | undefined {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (options?.readOnly) {
    maintenance?.assertReadAdmission();
  } else {
    maintenance?.assertAdmission();
  }
  assertExistingOpenClawStateSchemaCacheAdmission(resolvedPath, stateDatabaseLifecycle);
  const runtimeFailure = terminalOpenLatch.get(resolvedPath);
  if (runtimeFailure) {
    throw runtimeFailure;
  }
  const database = cachedDatabases.get(resolvedPath);
  if (database) {
    if (borrowers.get(database.db)?.retiring) {
      throw new Error(`OpenClaw state database native borrower cleanup is pending: ${pathname}`);
    }
    touchStateDatabase(database);
  }
  return database;
}

/** Keep the admitted revision live while a synchronous reader consumes its row facts. */
function withCachedOpenClawStateDatabase<T>(
  pathname: string,
  options: { readOnly: true } | undefined,
  operation: (database: OpenClawStateDatabase) => T,
): T | undefined {
  const database = getCachedOpenClawStateDatabase(pathname, options);
  return database && cacheAdmission.read(database, operation);
}

function getOpenClawStateDatabaseIfOpenAtPath(pathname: string): OpenClawStateDatabase | undefined {
  const cached = getCachedOpenClawStateDatabase(pathname);
  observeOpenClawDatabaseMaintenanceResource(cached?.db.isOpen ? cached.db : undefined);
  return cached?.db.isOpen ? cached : undefined;
}

/** Remove a closed cached owner while fresh-open access is held. */
function closeStaleCachedOpenClawStateDatabase(database: OpenClawStateDatabase): void {
  if (cachedDatabases.get(database.path) !== database) {
    return;
  }
  asyncResources.invalidate(database.path);
  const errors = closeOpenClawStateDatabaseHandle(database);
  notifyOpenClawStateDatabaseClosed(database);
  throwSqliteLifecycleErrors(
    errors,
    `Stale OpenClaw state database cleanup failed for ${database.path}.`,
  );
}

/** Latch integrity refusals so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(pathname: string, error: Error): void {
  terminalOpenLatch.record(resolveDatabasePath({ path: pathname }), error);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  terminalOpenLatch.clear(resolvedPath);
  asyncResources.invalidate(resolvedPath);
  notifyOpenClawStateDatabaseLifecycle({
    kind: "failure-cleared",
    path: resolvedPath,
    identity: asyncResources.knownIdentity(resolvedPath),
  });
}

/** Validate the canonical terminal fact before acquiring a domain-operation lease. */
export async function getOpenClawStateDatabaseTerminalFailureAsync(
  context: OpenClawStateWorkerContext,
  signal?: AbortSignal,
): Promise<Error | undefined> {
  context.admission.assertCurrent();
  signal?.throwIfAborted();
  return terminalOpenLatch.get(context.admission.databasePath);
}

/** Reject shared-state access after a process-local terminal failure. */
function assertOpenClawStateDatabaseOpenAllowed(pathname: string, ownership?: "cached-read"): void {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  const assertAllowed =
    ownership === "cached-read" ? assertStateDatabaseReadAllowed : assertStateDatabaseAccessAllowed;
  assertAllowed(pathname);
  const { identity } = asyncResources.capture(resolvedPath);
  const terminalFailure = terminalOpenLatch.get(resolvedPath);
  if (terminalFailure) {
    throw terminalFailure;
  }
  for (const database of retainedDatabaseHandles.values()) {
    if (
      borrowers.get(database.db)?.retiring &&
      (database.path === resolvedPath || databaseIdentities.get(database.db)?.key === identity.key)
    ) {
      throw new Error(`OpenClaw state database native borrower cleanup is pending: ${pathname}`);
    }
  }
}

function recordOpenClawStateDatabaseLifecycleOpenError(pathname: string, error: unknown): void {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: resolvedPath, error });
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
  pathname: string,
  env: NodeJS.ProcessEnv,
  onNativeCleanupFailure?: (error: OpenClawQuarantineReadCleanupError) => void,
): void {
  assertOpenClawStateDatabaseOpenAllowed(pathname);
  let quarantineFailure: Error | undefined;
  try {
    quarantineFailure = readOpenClawDatabaseQuarantineFailure("state", pathname, { env });
  } catch (error) {
    if (!(error instanceof OpenClawQuarantineReadCleanupError)) {
      throw error;
    }
    onNativeCleanupFailure?.(error);
    return;
  }
  if (quarantineFailure?.cause instanceof OpenClawQuarantineReadCleanupError) {
    onNativeCleanupFailure?.(quarantineFailure.cause);
  }
  if (quarantineFailure) {
    // Another process can record quarantine. Revoke admitted owners without a
    // process-local latch that could outlive the durable decision's generation.
    cacheAdmission.closeTerminalFailure(pathname, quarantineFailure);
    throw quarantineFailure;
  }
}

/** SQLite owns checkpoint exclusion; retirement joins the actual native handle. */
function retireOpenClawStateDatabaseHandle(
  database: StateDatabaseHandle,
  retireAdmission = true,
  options?: OpenClawStateDatabaseCloseOptions,
): void {
  // Retained native custody permits disposal after the caller loses admission.
  assertStateDatabaseBorrowersReleased(borrowers.get(database.db), database.path);
  const borrowedOwner = borrowers.get(database.db);
  try {
    const wasCached = cachedDatabases.get(database.path)?.db === database.db;
    if (retireAdmission) {
      asyncResources.invalidate(database.path);
    }
    const errors = closeOpenClawStateDatabaseHandle(database, options);
    if (wasCached && retireAdmission) {
      try {
        notifyOpenClawStateDatabaseClosed(database);
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(
      errors,
      `OpenClaw state database cleanup failed for ${database.path}.`,
    );
  } catch (error) {
    if (borrowedOwner) {
      retainStateDatabaseClose(database);
    }
    throw error;
  }
  if (borrowedOwner) {
    borrowedOwner.cleanupComplete = true;
    borrowers.delete(database.db);
  }
}

/** Close cached and disposal-only handles, preserving independent cleanup failures. */
function retireOpenClawStateDatabaseHandles(
  pathname?: string,
  options?: OpenClawStateDatabaseCloseOptions,
  identity?: DatabasePathIdentity,
): boolean {
  const databases = new Set<StateDatabaseHandle>([
    ...retainedDatabaseHandles.values(),
    ...cachedDatabases.values(),
  ]);
  const errors: unknown[] = [];
  let found = false;
  for (const database of databases) {
    if (
      pathname !== undefined &&
      database.path !== pathname &&
      (identity === undefined || databaseIdentities.get(database.db)?.key !== identity.key)
    ) {
      continue;
    }
    found = true;
    try {
      retireOpenClawStateDatabaseHandle(database, true, options);
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "OpenClaw state database cleanup failed.");
  return found;
}

export function closeOpenClawStateDatabaseByPath(
  pathname: string,
  options?: OpenClawStateDatabaseCloseOptions,
): boolean {
  return retireOpenClawStateDatabaseHandles(
    resolveDatabasePath({ path: pathname }),
    options,
    asyncResources.identity(pathname),
  );
}

export function closeOpenClawStateDatabase(options?: OpenClawStateDatabaseCloseOptions): void {
  retireOpenClawStateDatabaseHandles(undefined, options);
}

/** Register a resource owner before it can admit any shared-state worker opens. */
export const registerOpenClawStateDatabaseAsyncResource = asyncResources.register;

/** Close the admitted file or its canonical path, retaining first-creation identity getters. */
export function registerOpenClawStatePathAsyncResource(
  admission: Pick<OpenClawStateDatabaseReadAdmission, "identity">,
  close: () => Promise<void>,
): () => void {
  return registerOpenClawStateDatabaseAsyncResource({
    close(identity) {
      if (
        !identity ||
        identity.key === admission.identity.key ||
        identity.canonicalPath === admission.identity.canonicalPath
      ) {
        return close();
      }
      return Promise.resolve();
    },
  });
}

/** Capture the canonical read generation before any asynchronous worker admission. */
export const captureOpenClawStateDatabaseReadAdmission = asyncResources.capture;

export const captureOpenClawStateIntegrityAdmission = asyncResources.integrity;

/** Bind worker-created storage to its captured admission without publishing a native handle. */
export function publishOpenClawStateDatabaseWorkerAdmission(
  admission: OpenClawStateDatabaseReadAdmission,
  preparedIdentity?: DatabasePathIdentity,
): void {
  if (preparedIdentity) {
    admission.assertCurrent();
  }
  asyncResources.publish(admission.databasePath, preparedIdentity);
  admission.assertCurrent();
}

/** Drain worker resources before native checkpoint/close at one exact path. */
export function closeOpenClawStateDatabaseByPathAsync(
  pathname: string,
  options?: OpenClawStateDatabaseCloseOptions,
): Promise<boolean> {
  const resolvedPath = resolveDatabasePath({ path: pathname });
  return asyncResources.close(resolvedPath, async (identity) => {
    await stopOpenClawStateDatabaseMaintenance(resolvedPath, identity);
    return retireOpenClawStateDatabaseHandles(resolvedPath, options, identity);
  });
}

/** Orderly lifecycle close; synchronous close remains native/exit cleanup only. */
export async function closeOpenClawStateDatabaseAsync(
  options?: OpenClawStateDatabaseCloseOptions,
): Promise<void> {
  await asyncResources.close(undefined, async () => {
    await stopOpenClawStateDatabaseMaintenance();
    return retireOpenClawStateDatabaseHandles(undefined, options);
  });
}

export function isOpenClawStateDatabaseOpen(pathname?: string): boolean {
  if (pathname !== undefined) {
    return cachedDatabases.get(resolveDatabasePath({ path: pathname }))?.db.isOpen === true;
  }
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/**
 * Close shared state handles and clear terminal failure latches for test isolation.
 * Worker retirement continues after return; await closeOpenClawStateDatabaseAsync()
 * before raw SQLite or file access to a database that workers have used.
 */
export function closeOpenClawStateDatabaseForTest(): void {
  closeOpenClawStateDatabase();
  terminalOpenLatch.clearAll();
}

/**
 * Owners that register with this cache must serve only the published lifecycle.
 * Every runtime chunk shares that lifecycle; only a retired module generation
 * (a re-evaluated test graph whose detached work outlived its file) can differ.
 */
export function assertPublishedOpenClawStateDatabaseLifecycle(): void {
  if (readGlobalSingleton(STATE_DATABASE_LIFECYCLE_KEY) !== stateDatabaseLifecycle) {
    throw new Error(
      "OpenClaw state database lifecycle is retired; its owners cannot serve the published lifecycle",
    );
  }
}

/** Process-wide owner for cached shared-state handles and terminal open failures. */
export const openClawStateDatabaseCache = {
  assertOpenClawStateDatabaseFreshOpenAllowedAtPath,
  assertOpenClawStateDatabaseOpenAllowed,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseHandle,
  closeUnpublishedOpenClawStateDatabaseHandle,
  closeStaleCachedOpenClawStateDatabase,
  evictCachedOpenClawStateDatabase,
  evictOpenClawStateDatabaseAfterCorruption,
  getCachedOpenClawStateDatabase,
  // Identity only: re-enter retained transaction custody before ordinary access admission.
  peekOpenClawStateDatabaseConnection: (pathname: string): EngineConnection | undefined =>
    cachedDatabases.get(resolveDatabasePath({ path: pathname }))?.db,
  withCachedOpenClawStateDatabase,
  getOpenClawStateDatabaseRecordedFailure: terminalOpenLatch.peek,
  getOpenClawStateDatabaseIfOpenAtPath,
  getKnownOpenClawStateDatabaseIdentity: asyncResources.knownIdentity,
  isOpenClawStateDatabaseOpen,
  /** Only the exact published, open owner carries canonical schema readiness. */
  isOpenClawStateDatabaseSchemaReady: (database: OpenClawStateDatabase): boolean =>
    cachedDatabases.get(database.path) === database && database.db.isOpen,
  publishOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseLifecycleOpenError,
  touchStateDatabase,
};

/** Offline removal drains local work and refuses an active native SQLite owner. */
export async function prepareOpenClawStateDatabaseRemoval(
  pathname: string,
  assertOwnerCurrent: () => void,
) {
  const databasePath = resolveDatabasePath({ path: pathname });
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("State removal requires the installation's maintenance owner");
  }
  maintenance.assertAdmission();
  const releaseAdmission = asyncResources.holdExclusion(databasePath);
  try {
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    maintenance.assertOwnerCurrent();
    retainSqliteDatabaseRemovalExclusion(databasePath, maintenance);
    maintenance.assertOwnerCurrent();
  } catch (error) {
    releaseAdmission();
    throw error;
  }
  let active = true;
  return {
    assertCurrent() {
      if (!active) {
        throw new Error("State removal admission has been released");
      }
      assertOwnerCurrent();
    },
    release() {
      if (active) {
        active = false;
        releaseAdmission();
      }
    },
  };
}

function retainSqliteDatabaseRemovalExclusion(
  databasePath: string,
  maintenance: OpenClawDatabaseMaintenanceScope,
): void {
  if (!existsSync(databasePath)) {
    return;
  }
  const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(databasePath));
  const close = () => {
    if (!database.isOpen) {
      return;
    }
    const errors: unknown[] = [];
    try {
      if (database.isTransaction) {
        database.exec("ROLLBACK"); // sqlite-allow-raw -- Release the native removal exclusion before close.
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
    throwSqliteLifecycleErrors(errors, "SQLite state removal exclusion cleanup failed.");
  };
  try {
    // The maintenance owner drains this handle after state removal. A failed
    // close retains both native custody and the external process owner.
    maintenance.own(database, "shared-handles", close);
    // Exclusive connection mode obtains the main-file lock even in WAL mode.
    // Do not change journal_mode: a refused removal must preserve recovery bytes.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); // sqlite-allow-raw -- Native file-removal exclusion, without mutating journal mode.
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite state removal admission and cleanup both failed.",
        error,
      );
    }
    if (isSqliteLockError(error)) {
      throw new Error(
        "Cannot remove OpenClaw state directory while another SQLite connection is active",
        {
          cause: error,
        },
      );
    }
    const code = sqlitePrimaryResultCode(error);
    // Explicit reset may remove corrupt state after process ownership is established.
    if (code !== 11 && code !== 26) {
      throw error;
    }
    return;
  }
  if (process.platform === "win32") {
    // WinVFS denies FILE_SHARE_DELETE: any peer handle prevents unlink. Our
    // own probe must close so removal can proceed when no peer remains.
    close();
  }
}
