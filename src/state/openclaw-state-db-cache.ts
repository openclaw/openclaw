import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteKyselyQueryErrorHandler,
} from "../infra/kysely-sync-cache-state.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "../infra/sqlite-coordinator.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import {
  prepareSqliteReadOnlyLocationFromOwnedDatabase,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "../infra/sqlite-readonly-location.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createOpenClawDatabaseVerificationError,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  createOpenClawStateDatabaseAsyncLifecycle,
  type OpenClawStateDatabaseAsyncResource,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { createOpenClawStateDatabaseRuntimeFailureOwner } from "./openclaw-state-db-runtime-failure.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type StateDatabaseHandle = Pick<OpenClawStateDatabase, "db" | "path"> &
  Partial<Pick<OpenClawStateDatabase, "walMaintenance">> & {
    afterClose?: () => undefined;
  };
type OpenClawStateDatabaseCloseOptions = NonNullable<
  Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0]
> & { busyTimeoutMs?: number };
type OpenClawStateDatabaseLifecycleEvent =
  | { kind: "opened"; database: OpenClawStateDatabase; identity: DatabasePathIdentity }
  | { kind: "closed"; path: string; identity: DatabasePathIdentity }
  | { kind: "failure-cleared"; path: string; identity?: DatabasePathIdentity }
  | { kind: "terminal-failure"; path: string; identity?: DatabasePathIdentity; error: Error }
  | { kind: "open-error"; path: string; identity?: DatabasePathIdentity; error: unknown };
type StateDatabaseLifecycle = {
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  retainedDatabaseHandles: Map<DatabaseSync, StateDatabaseHandle>;
  unregisterRetainedExitClose?: () => void;
  cachedDataVersionStatements: WeakMap<OpenClawStateDatabase, ReturnType<DatabaseSync["prepare"]>>;
  cachedDataVersions: WeakMap<DatabaseSync, number>;
  databaseIdentities: WeakMap<DatabaseSync, DatabasePathIdentity>;
  databaseLifecycleListeners: Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>;
  terminalOpenLatch: ReturnType<typeof createSqliteTerminalOpenLatch>;
  asyncResources: ReturnType<typeof createOpenClawStateDatabaseAsyncLifecycle>;
};
const stateDatabaseLifecycle = resolveGlobalSingleton<StateDatabaseLifecycle>(
  Symbol.for("openclaw.stateDatabaseLifecycle"),
  () => ({
    cachedDatabases: new Map<string, OpenClawStateDatabase>(),
    retainedDatabaseHandles: new Map<DatabaseSync, StateDatabaseHandle>(),
    unregisterRetainedExitClose: undefined,
    // The plain owner key must not retain the statement's own native database.
    cachedDataVersionStatements: new WeakMap<
      OpenClawStateDatabase,
      ReturnType<DatabaseSync["prepare"]>
    >(),
    cachedDataVersions: new WeakMap<DatabaseSync, number>(),
    databaseIdentities: new WeakMap<DatabaseSync, DatabasePathIdentity>(),
    databaseLifecycleListeners: new Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>(),
    terminalOpenLatch: createSqliteTerminalOpenLatch({
      closeByPath: (pathname, error) => {
        asyncResources.invalidate(pathname);
        const cached = cachedDatabases.get(pathname);
        const errors: unknown[] = [];
        try {
          if (cached) {
            evictCachedOpenClawStateDatabase(cached);
          }
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        try {
          notifyOpenClawStateDatabaseLifecycle({
            kind: "terminal-failure",
            path: pathname,
            error,
            identity: asyncResources.knownIdentity(pathname),
          });
        } catch (notificationError) {
          errors.push(notificationError);
        }
        throwStateDatabaseCleanupErrors(errors, "Terminal shared-state failure cleanup failed");
      },
    }),
    asyncResources: createOpenClawStateDatabaseAsyncLifecycle(),
  }),
  () => closeOpenClawStateDatabaseAsync(),
);
const {
  cachedDatabases,
  retainedDatabaseHandles,
  cachedDataVersionStatements,
  cachedDataVersions,
  databaseIdentities,
  databaseLifecycleListeners,
  terminalOpenLatch,
  asyncResources,
} = stateDatabaseLifecycle;

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

function requireOpenClawStateDatabaseIdentity(database: StateDatabaseHandle): DatabasePathIdentity {
  const identity = databaseIdentities.get(database.db);
  if (!identity) {
    throw new Error("Published shared-state owner has no recorded database identity");
  }
  return identity;
}

const runtimeFailures = createOpenClawStateDatabaseRuntimeFailureOwner({
  cachedDatabases,
  statements: cachedDataVersionStatements,
  dataVersions: cachedDataVersions,
  latch: terminalOpenLatch,
  evict: evictCachedOpenClawStateDatabase,
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

/** Close both physical-handle owners while retaining every cleanup failure. */
function closeOpenClawStateDatabaseHandle(
  database: StateDatabaseHandle,
  options?: Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0],
): unknown[] {
  const errors: unknown[] = [];
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
    retainedDatabaseHandles.set(database.db, database);
    stateDatabaseLifecycle.unregisterRetainedExitClose ??= registerSqliteCacheExitClose(
      closeOpenClawStateDatabase,
    );
  } else {
    retainedDatabaseHandles.delete(database.db);
    if (retainedDatabaseHandles.size === 0) {
      stateDatabaseLifecycle.unregisterRetainedExitClose?.();
      stateDatabaseLifecycle.unregisterRetainedExitClose = undefined;
    }
  }
  // A failed native close retains physical custody, never a successful cache hit.
  if (cachedDatabases.get(database.path)?.db === database.db) {
    cachedDatabases.delete(database.path);
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
  const identity = asyncResources.publish(pathname);
  databaseIdentities.set(db, identity);
  runtimeFailures.recordPublishedVersion(database);
  cachedDatabases.set(pathname, database);
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

const getOpenClawStateDatabaseRuntimeFailure = runtimeFailures.get;

function getCachedOpenClawStateDatabase(pathname: string): OpenClawStateDatabase | undefined {
  const runtimeFailure = getOpenClawStateDatabaseRuntimeFailure(pathname);
  if (runtimeFailure) {
    throw runtimeFailure;
  }
  return cachedDatabases.get(path.resolve(pathname));
}

function getOpenClawStateDatabaseIfOpenAtPath(pathname: string): OpenClawStateDatabase | undefined {
  const cached = getCachedOpenClawStateDatabase(pathname);
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
  throwStateDatabaseCleanupErrors(
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
  asyncResources.identity(pathname);
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
}

function recordOpenClawStateDatabaseLifecycleOpenError(pathname: string, error: unknown): void {
  notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: path.resolve(pathname), error });
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
  pathname: string,
  env: NodeJS.ProcessEnv,
): void {
  assertOpenClawStateDatabaseOpenAllowed(pathname);
  let quarantineFailure: Error | undefined;
  try {
    const quarantine = readOpenClawDatabaseQuarantine(pathname, { env });
    if (quarantine) {
      quarantineFailure = createOpenClawDatabaseVerificationError(
        "state",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every state read.
    // The process latch and daily verifier still cover known damage.
  }
  if (quarantineFailure) {
    throw quarantineFailure;
  }
}

/** Explicit retirement can checkpoint WAL and must join the lifecycle writer gate. */
function retireOpenClawStateDatabaseHandle(
  database: StateDatabaseHandle,
  options?: OpenClawStateDatabaseCloseOptions,
): void {
  const { busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, ...closeOptions } = options ?? {};
  // Wait opportunistically within the budget; contended retirement must not write
  // any database or sidecar bytes while a foreign lifecycle owner holds exclusion.
  const coordinator = acquireStateDatabaseCoordinator({
    databasePath: database.path,
    busyTimeoutMs,
    // Retirement releases physical custody, including an idle coordinator that
    // would otherwise keep temporary or relocated Windows homes undeletable.
    keepAlive: false,
  });
  runWithSqliteCoordinator(coordinator, "state database retirement", () => {
    // Refused acquisition leaves both cache and physical ownership untouched.
    const wasCached = cachedDatabases.get(database.path)?.db === database.db;
    asyncResources.invalidate(database.path);
    const errors = closeOpenClawStateDatabaseHandle(database, closeOptions);
    if (wasCached) {
      try {
        notifyOpenClawStateDatabaseClosed(database);
      } catch (error) {
        errors.push(error);
      }
    }
    throwStateDatabaseCleanupErrors(
      errors,
      `OpenClaw state database cleanup failed for ${database.path}.`,
    );
  });
}

function throwStateDatabaseCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, message, errors[0]);
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
      retireOpenClawStateDatabaseHandle(database, options);
    } catch (error) {
      errors.push(error);
    }
  }
  throwStateDatabaseCleanupErrors(errors, "OpenClaw state database cleanup failed.");
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
export function captureOpenClawStateDatabaseReadAdmission(
  pathname: string,
): OpenClawStateDatabaseReadAdmission {
  return asyncResources.capture(pathname);
}

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
  closeStaleCachedOpenClawStateDatabase,
  evictCachedOpenClawStateDatabase,
  evictOpenClawStateDatabaseAfterCorruption,
  getCachedOpenClawStateDatabase,
  getOpenClawStateDatabaseRuntimeFailure,
  getOpenClawStateDatabaseIfOpenAtPath,
  isOpenClawStateDatabaseOpen,
  publishOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseLifecycleOpenError,
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
  return {
    assertCurrent: handles.assertCurrent,
    runWithSourceReads: handles.runWithSourceReads,
    assertMutationCurrent: handles.assertMutationCurrent,
    async mutate<T>(assertCurrent: () => void, operation: () => Promise<T>): Promise<T> {
      let outcome: { value: T } | { error: unknown };
      try {
        outcome = {
          value: await handles.runWithCanonicalMutation(
            assertCurrent,
            operation,
            async (assertInspection) => {
              assertInspection();
              const opened = getOpenClawStateDatabaseIfOpenAtPath(databasePath);
              if (opened) {
                return await prepareSqliteReadOnlyLocationFromOwnedDatabase(opened.db, () => {
                  assertInspection();
                  if (getOpenClawStateDatabaseIfOpenAtPath(databasePath) !== opened) {
                    throw new Error("SQLite inspection lost its original native owner");
                  }
                });
              }
              // Before first open, no cached OR uncached source handle may exist.
              handles.assertDrainedDuringMutation();
              return await handles.runWithSourceReads(async () => {
                assertInspection();
                return prepareSqliteReadOnlyLocationSyncInProcess(databasePath);
              });
            },
          ),
        };
      } catch (error) {
        outcome = { error };
      }
      const errors: unknown[] = "error" in outcome ? [outcome.error] : [];
      const database = cachedDatabases.get(databasePath);
      if (database) {
        try {
          // Physical custody permits closure, never another mutation after authority loss.
          handles.runWithCanonicalWrites(handles.assertCurrent, () => {
            errors.push(...closeOpenClawStateDatabaseHandle(database));
          });
          notifyOpenClawStateDatabaseClosed(database);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        handles.assertNoPins();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "SQLite mutation or drainage failed",
          errors[0],
        );
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    },
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
      const database = cachedDatabases.get(databasePath);
      if (database) {
        try {
          // Cleanup retains physical custody even if mutation authority expired.
          // No user callback or lifecycle notification runs in this scope.
          handles.runWithCanonicalWrites(handles.assertCurrent, () => {
            errors.push(...closeOpenClawStateDatabaseHandle(database));
          });
          notifyOpenClawStateDatabaseClosed(database);
        } catch (error) {
          errors.push(error);
        }
      }
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
