import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteKyselyQueryErrorHandler,
} from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import {
  isSqliteCorruptionError,
  isSqliteLockError,
  sqlitePrimaryResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { cancelSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import {
  createOpenClawStateDatabaseAsyncLifecycle,
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawDatabaseMaintenanceScope,
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
import { createStateDatabaseWalOwner } from "./openclaw-state-db-cache.wal.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseCloseOptions,
  OpenClawStateDatabaseLifecycleEvent,
  StateDatabaseHandle,
} from "./openclaw-state-db-contract.js";
import { closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { createOpenClawStateDatabaseRuntimeFailureOwner } from "./openclaw-state-db-runtime-failure.js";
import { assertExistingOpenClawStateSchemaCacheAdmission } from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { openClawStateSnapshotOwners } from "./openclaw-state-db-snapshot-owner.js";
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
const { register: registerStateDatabaseWalAdmission, readHealth: readOpenClawStateWalHealth } =
  createStateDatabaseWalOwner(stateDatabaseLifecycle, retainOpenClawStateDatabaseForIdle);
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
  getOpenClawDatabaseMaintenanceScope()?.own(database.db, "shared-handles", async () => {
    const closingScope = getOpenClawDatabaseMaintenanceScope();
    if (!closingScope || !isOpenClawDatabaseMaintenanceResourceOwned(database.db, closingScope)) {
      return;
    }
    if (
      cachedDatabases.get(database.path) === database ||
      retainedDatabaseHandles.get(database.db) === database
    ) {
      await cancelSqliteWalWriteAdmission(database.db);
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
    void cancelSqliteWalWriteAdmission(database.db);
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
function publishOpenClawStateDatabase(
  database: OpenClawStateDatabase,
  env: NodeJS.ProcessEnv,
): OpenClawStateDatabase {
  const { db, path: pathname } = database;
  admitSqliteSchema(db);
  assertSupportedStateSchemaVersion(db, pathname);
  const { identity, admission } = asyncResources.publish(pathname);
  databaseIdentities.set(db, identity);
  cachedDatabases.set(pathname, database);
  registerStateDatabaseWalAdmission(database, identity, admission, env);
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

function getCachedOpenClawStateDatabase(
  pathname: string,
  options?: { readOnly: true },
): OpenClawStateDatabase | undefined {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (options?.readOnly) {
    maintenance?.assertReadAdmission();
  } else {
    maintenance?.assertAdmission();
  }
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
  assertStateDatabaseAccessAllowed(pathname);
  const { identity } = asyncResources.capture(pathname);
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  const resolvedPath = path.resolve(pathname);
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
  notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: path.resolve(pathname), error });
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
    runtimeFailures.closeTerminalFailure(pathname, quarantineFailure);
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

/** Offline removal drains local work and refuses an active native SQLite owner. */
export async function prepareOpenClawStateDatabaseRemoval(
  pathname: string,
  assertOwnerCurrent: () => void,
) {
  const databasePath = path.resolve(pathname);
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

/** Reconfirm an advisory worker failure on the live owner connection. */
export async function confirmOpenClawStateDatabaseIntegrity(
  pathname: string,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = path.resolve(pathname);
  await closeOpenClawStateDatabaseByPathAsync(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}
