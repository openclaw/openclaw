import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteKyselyQueryErrorHandler,
} from "../infra/kysely-sync-cache-state.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-coordinator.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { admitSqliteSchema, waitForSqliteSchemaProbeTurn } from "../infra/sqlite-schema-facts.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { registerSqliteCacheExitClose, type SqliteWalHealth } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { assertOpenClawStateDatabaseNotQuarantined } from "./openclaw-quarantine-store.js";
import {
  createOpenClawStateDatabaseAsyncLifecycle,
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawStateDatabaseAsyncResource,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  assertStateDatabaseBorrowersReleased,
  createStateDatabaseRetainer,
  type StateDatabaseBorrowers,
} from "./openclaw-state-db-borrow.js";
import { createStateDatabaseIdleRetirement } from "./openclaw-state-db-cache.idle.js";
import type { StateDatabaseLifecycle } from "./openclaw-state-db-cache.types.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseCloseOptions,
  type OpenClawStateDatabaseLifecycleEvent,
  type StateDatabaseHandle,
} from "./openclaw-state-db-contract.js";
import { closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { createOpenClawStateDatabaseRuntimeFailureOwner } from "./openclaw-state-db-runtime-failure.js";
import { assertExistingOpenClawStateSchemaCacheAdmission } from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { openClawStateSnapshotOwners } from "./openclaw-state-db-snapshot-owner.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const stateDatabaseLifecycle = resolveGlobalSingleton<StateDatabaseLifecycle>(
  Symbol.for("openclaw.stateDatabaseLifecycle"),
  () => ({
    cachedDatabases: new Map<string, OpenClawStateDatabase>(),
    retainedDatabaseHandles: new Map<DatabaseSync, StateDatabaseHandle>(),
    idleTimers: new WeakMap(),
    idleReferences: new WeakMap(),
    unregisterRetainedExitClose: undefined,
    databaseIdentities: new WeakMap<DatabaseSync, DatabasePathIdentity>(),
    borrowers: new WeakMap<DatabaseSync, StateDatabaseBorrowers>(),
    databaseLifecycleListeners: new Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>(),
    terminalOpenLatch: createSqliteTerminalOpenLatch({
      closeByPath: (pathname, error) => runtimeFailures.closeTerminalFailure(pathname, error),
    }),
    asyncResources: createOpenClawStateDatabaseAsyncLifecycle(),
  }),
  () => closeOpenClawStateDatabaseAsync(),
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
export { retainOpenClawStateDatabaseForIdle };

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

const runtimeFailures = createOpenClawStateDatabaseRuntimeFailureOwner({
  cachedDatabases,
  latch: terminalOpenLatch,
  evict: evictCachedOpenClawStateDatabase,
  invalidate: (pathname) => asyncResources.invalidate(pathname),
  notifyTerminalFailure: (pathname, error) =>
    notifyOpenClawStateDatabaseLifecycle({
      kind: "terminal-failure",
      path: pathname,
      error,
      identity: asyncResources.knownIdentity(pathname),
    }),
  recordSchemaFailure: (pathname, error) => {
    terminalOpenLatch.record(pathname, error);
    notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: pathname, error });
  },
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

function retainStateDatabaseClose(database: StateDatabaseHandle): void {
  retainedDatabaseHandles.set(database.db, database);
  stateDatabaseLifecycle.unregisterRetainedExitClose ??= registerSqliteCacheExitClose(
    closeOpenClawStateDatabase,
  );
}

function ownMaintenanceStateDatabaseHandle(database: StateDatabaseHandle): void {
  getOpenClawDatabaseMaintenanceScope()?.own(database.db, "shared-handles", () => {
    if (
      cachedDatabases.get(database.path) === database ||
      retainedDatabaseHandles.get(database.db) === database
    ) {
      retireOpenClawStateDatabaseHandle(database, false);
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
  assertOpen(pathname) {
    assertOpenClawStateDatabaseOpenAllowed(pathname);
    assertExistingOpenClawStateSchemaCacheAdmission(pathname, stateDatabaseLifecycle);
  },
  capture: (pathname) => asyncResources.capture(pathname),
  retire: retireOpenClawStateDatabaseHandle,
  retainFailed: retainStateDatabaseClose,
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
  const errors: unknown[] = [];
  openClawStateSnapshotOwners.release(database.db);
  try {
    database.walMaintenance?.close(options);
  } catch (error) {
    errors.push(error);
  }
  try {
    clearNodeSqliteKyselyCacheForDatabase(database.db);
  } catch (error) {
    errors.push(error);
  }
  try {
    closeTrackedStateDatabase(database.db);
  } catch (error) {
    errors.push(error);
  }
  let cleanupPending = false;
  if (!database.db.isOpen) {
    try {
      database.afterClose?.();
    } catch (error) {
      errors.push(error);
      cleanupPending = true;
    }
  }
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
function publishOpenClawStateDatabase(database: OpenClawStateDatabase): OpenClawStateDatabase {
  const { db, path: pathname } = database;
  admitSqliteSchema(db);
  assertSupportedStateSchemaVersion(db, pathname);
  const identity = asyncResources.publish(pathname);
  databaseIdentities.set(db, identity);
  cachedDatabases.set(pathname, database);
  touchStateDatabase(database);
  openClawStateSnapshotOwners.register(database, () => cachedDatabases.get(pathname));
  ownMaintenanceStateDatabaseHandle(database);
  notifyOpenClawStateDatabaseLifecycle({ kind: "opened", database, identity });
  registerNodeSqliteKyselyQueryErrorHandler(db, (error) => {
    // Write transactions own rollback and evict at their outer boundary.
    if (!db.isTransaction && isSqliteCorruptionError(error)) {
      evictCachedOpenClawStateDatabase(database);
    }
  });
  terminalOpenLatch.clear(pathname);
  return database;
}

function waitForCachedOpenClawStateSchemaProbe(pathname: string): Promise<void> | undefined {
  const database = cachedDatabases.get(pathname);
  return database ? waitForSqliteSchemaProbeTurn(database.db) : undefined;
}

function getCachedOpenClawStateDatabase(pathname: string): OpenClawStateDatabase | undefined {
  getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
  assertExistingOpenClawStateSchemaCacheAdmission(pathname, stateDatabaseLifecycle);
  const runtimeFailure = runtimeFailures.get(pathname);
  if (runtimeFailure) {
    throw runtimeFailure;
  }
  const database = cachedDatabases.get(path.resolve(pathname));
  if (database && borrowers.get(database.db)?.retiring) {
    throw new Error(`OpenClaw state database native borrower cleanup is pending: ${pathname}`);
  }
  if (database) {
    touchStateDatabase(database);
  }
  return database;
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

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  return terminalOpenLatch.record(pathname, error, generation);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  const resolvedPath = path.resolve(pathname);
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
): Promise<Error | undefined> {
  context.admission.assertCurrent();
  const failure = await terminalOpenLatch.getAsync(
    context.admission.databasePath,
    async (_path, generation) => {
      const { inspectOpenClawStateDatabase } = await import("./openclaw-state-worker-store.js");
      const matches = await inspectOpenClawStateDatabase(context, {
        type: "database.generationMatches",
        input: { generation },
      });
      if (matches === undefined) {
        throw new Error("Recorded shared-state database generation is unavailable");
      }
      return matches;
    },
  );
  context.admission.assertCurrent();
  return failure;
}

/** Reject shared-state access after a process-local terminal failure. */
function assertOpenClawStateDatabaseOpenAllowed(pathname: string): void {
  const identity = asyncResources.identity(pathname);
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  const resolvedPath = path.resolve(pathname);
  for (const database of retainedDatabaseHandles.values()) {
    if (
      borrowers.get(database.db)?.retiring &&
      (database.path === resolvedPath ||
        (identity !== undefined && databaseIdentities.get(database.db)?.key === identity.key))
    ) {
      throw new Error(`OpenClaw state database native borrower cleanup is pending: ${pathname}`);
    }
  }
}

function recordOpenClawStateDatabaseLifecycleOpenError(pathname: string, error: unknown): void {
  notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: path.resolve(pathname), error });
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
  pathname: string,
  env: NodeJS.ProcessEnv,
  onNativeCleanupFailure?: (error: OpenClawQuarantineReadCleanupError) => void,
): void {
  assertOpenClawStateDatabaseOpenAllowed(pathname);
  assertOpenClawStateDatabaseNotQuarantined(pathname, env, onNativeCleanupFailure);
}

/** Explicit retirement can checkpoint WAL and must join the lifecycle writer gate. */
function retireOpenClawStateDatabaseHandle(
  database: StateDatabaseHandle,
  retireAdmission = true,
  options?: OpenClawStateDatabaseCloseOptions,
): void {
  assertStateDatabaseBorrowersReleased(borrowers.get(database.db), database.path);
  const borrowedOwner = borrowers.get(database.db);
  const { busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, ...closeOptions } = options ?? {};
  // Wait opportunistically within the budget; contended retirement must not write
  // any database or sidecar bytes while a foreign lifecycle owner holds exclusion.
  const coordinator =
    borrowedOwner?.closeCoordinator ??
    acquireStateDatabaseCoordinator({
      databasePath: database.path,
      busyTimeoutMs,
      // Retirement releases physical custody, including an idle coordinator that
      // would otherwise keep temporary or relocated Windows homes undeletable.
      keepAlive: false,
    });
  if (borrowedOwner) {
    borrowedOwner.closeCoordinator = coordinator;
  }
  try {
    runWithSqliteCoordinator(coordinator, "state database retirement", () => {
      // Refused acquisition leaves both cache and physical ownership untouched.
      const wasCached = cachedDatabases.get(database.path)?.db === database.db;
      if (retireAdmission) {
        asyncResources.invalidate(database.path);
      }
      const errors = closeOpenClawStateDatabaseHandle(database, closeOptions);
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
    });
  } catch (error) {
    if (borrowedOwner) {
      retainStateDatabaseClose(database);
    }
    throw error;
  } finally {
    if (borrowedOwner && coordinator.closed) {
      borrowedOwner.closeCoordinator = undefined;
    }
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

/** Close one cached shared state database handle by exact pathname. */
export function closeOpenClawStateDatabaseByPath(
  pathname: string,
  options?: OpenClawStateDatabaseCloseOptions,
): boolean {
  return retireOpenClawStateDatabaseHandles(
    path.resolve(pathname),
    options,
    asyncResources.identity(pathname),
  );
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(options?: OpenClawStateDatabaseCloseOptions): void {
  retireOpenClawStateDatabaseHandles(undefined, options);
}

/** Register a resource owner before it can admit any shared-state worker opens. */
export function registerOpenClawStateDatabaseAsyncResource(
  resource: OpenClawStateDatabaseAsyncResource,
): () => void {
  return asyncResources.register(resource);
}

/** Capture the canonical read generation before any asynchronous worker admission. */
export const captureOpenClawStateDatabaseReadAdmission = asyncResources.capture;

/** Bind worker-created storage to its captured admission without publishing a native handle. */
export function publishOpenClawStateDatabaseWorkerAdmission(
  admission: OpenClawStateDatabaseReadAdmission,
): void {
  admission.assertCurrent();
  asyncResources.publish(admission.databasePath);
  admission.assertCurrent();
}

/** Drain worker resources before native checkpoint/close at one exact path. */
export function closeOpenClawStateDatabaseByPathAsync(
  pathname: string,
  options?: OpenClawStateDatabaseCloseOptions,
): Promise<boolean> {
  const resolvedPath = path.resolve(pathname);
  return asyncResources.close(resolvedPath, (identity) =>
    retireOpenClawStateDatabaseHandles(resolvedPath, options, identity),
  );
}

/** Orderly lifecycle close; synchronous close remains native/exit cleanup only. */
export async function closeOpenClawStateDatabaseAsync(
  options?: OpenClawStateDatabaseCloseOptions,
): Promise<void> {
  await asyncResources.close(undefined, () =>
    retireOpenClawStateDatabaseHandles(undefined, options),
  );
}

/** Test whether a cached shared state database handle is still open, optionally at one path. */
export function isOpenClawStateDatabaseOpen(pathname?: string): boolean {
  if (pathname !== undefined) {
    return cachedDatabases.get(path.resolve(pathname))?.db.isOpen === true;
  }
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Report the live owner's last observation without opening or querying SQLite. */
export function readOpenClawStateWalHealth(): SqliteWalHealth | undefined {
  const database = cachedDatabases.get(path.resolve(resolveOpenClawStateSqlitePath()));
  return database?.db.isOpen ? database.walMaintenance.health : undefined;
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeOpenClawStateDatabaseForTest(): void {
  closeOpenClawStateDatabase();
  terminalOpenLatch.clearAll();
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
  waitForCachedOpenClawStateSchemaProbe,
  getOpenClawStateDatabaseRuntimeFailure: runtimeFailures.get,
  getOpenClawStateDatabaseRecordedFailure: terminalOpenLatch.peek,
  getOpenClawStateDatabaseIfOpenAtPath,
  getKnownOpenClawStateDatabaseIdentity: asyncResources.knownIdentity,
  isOpenClawStateDatabaseOpen,
  publishOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseLifecycleOpenError,
  touchStateDatabase,
};

/** Drain local cached owners before excluding participating foreign handles for file removal. */
export async function acquireOpenClawStateDatabaseFileExclusion(pathname: string) {
  const databasePath = path.resolve(pathname);
  const releaseAdmission = asyncResources.holdExclusion(databasePath);
  let lifecycle: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  let handles: ReturnType<typeof acquireStateDatabaseHandleExclusion>;
  try {
    // The admission seal spans drainage and acquisition; no worker can reopen
    // between native retirement and the physical exclusion becoming current.
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    lifecycle = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
    handles = acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 });
  } catch (error) {
    lifecycle?.release();
    releaseAdmission();
    throw error;
  }
  const closeWriter = (errors: unknown[]) => {
    const database = cachedDatabases.get(databasePath);
    if (database) {
      try {
        // Physical custody permits closure after authority loss, not further mutation.
        handles.runWithCanonicalWrites(handles.assertCurrent, () => {
          errors.push(...closeOpenClawStateDatabaseHandle(database));
        });
        notifyOpenClawStateDatabaseClosed(database);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  return {
    assertCurrent: handles.assertCurrent,
    runWithSourceReads: handles.runWithSourceReads,
    async bindCaptured(assertCurrent: () => void, operation: () => undefined): Promise<void> {
      const errors: unknown[] = [];
      let result: unknown;
      try {
        result = handles.runWithCanonicalWrites(assertCurrent, operation);
      } catch (error) {
        errors.push(error);
      }
      // Revoke issued raw SQLite capabilities before yielding to an invalid
      // async binder. Keep the physical fence until that promise has settled.
      closeWriter(errors);
      if (result !== undefined) {
        errors.push(new Error("checkpoint binding must complete synchronously with undefined"));
        try {
          await Promise.resolve(result);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        assertCurrent();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "checkpoint binding or writer closure failed",
          errors[0],
        );
      }
    },
    release: () => {
      try {
        handles.release();
      } finally {
        lifecycle?.release();
        releaseAdmission();
      }
    },
  };
}

/** Reconfirm an advisory worker failure on the live owner connection. */
export async function confirmOpenClawStateDatabaseIntegrity(
  pathname: string,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = path.resolve(pathname);
  await closeOpenClawStateDatabaseByPathAsync(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}
