import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { sleepWithAbort } from "@openclaw/retry";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { hasErrnoCode } from "../infra/errno.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import {
  retainSnapshotTempDirectory,
  retainSnapshotWork,
  SqliteSnapshotCleanupError,
} from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../infra/sqlite-readonly-location.js";
import type { AsyncPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { isUpdateRehearsalPrivateDatabase } from "../infra/update-rehearsal-paths.js";
import { getChildLogger } from "../logging/logger.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  artifactPreservingReads,
  isArtifactPreservingStateRead,
  withArtifactPreservingStateReads,
} from "./artifact-preserving-state-reads.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { readAdmittedStateContentVersion } from "./openclaw-state-db-content-version.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import {
  withCachedOpenClawStateDatabaseReadOnly,
  withMaintenanceOpenClawStateDatabaseReadOnly,
  type ReusedOpenClawStateReadOnlyDatabase,
} from "./openclaw-state-db-readonly-reuse.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined, resolveDatabasePath } from "./openclaw-state-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerMayCopySourcesInProcess,
} from "./openclaw-state-maintenance-context.js";
import {
  startOpenClawStateReadOperation,
  type OpenClawStateReadCompletion,
} from "./openclaw-state-read-operation.js";
import {
  assertRetainedReadScopeAdmission,
  bindRetainedReadScope,
  createRetainedReadScope,
  runRetainedReadScope,
  runSynchronousReadScope,
} from "./openclaw-state-read-scope.js";
import type {
  OpenClawStateReadReceipt,
  OpenClawStateReadOptions,
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
  OpenClawStateReadOnlyDatabase,
  RetainedReadScope,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

export {
  isArtifactPreservingStateRead,
  withArtifactPreservingStateReads,
} from "./artifact-preserving-state-reads.js";

const disposableStateReads = resolveGlobalSingleton(
  Symbol.for("openclaw.disposableStateReads"),
  () => new AsyncLocalStorage<RetainedReadScope[]>(),
);

const stateSnapshotReads = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSnapshotReads"),
  () =>
    new AsyncLocalStorage<
      RetainedReadScope & {
        location: string;
        cleanupRoot?: string;
        env: NodeJS.ProcessEnv;
        cleanClose?: boolean;
      }
    >(),
);

/** Stable identity and private bytes for reads within the enclosing snapshot scope. */
export function getActiveOpenClawStateDatabaseReadSnapshot(
  options: OpenClawStateDatabaseOptions = {},
): Readonly<{ location: string; cleanClose?: boolean }> | undefined {
  const current = stateSnapshotReads.getStore();
  return current?.path === resolveReadOnlyPath(options) ? current : undefined;
}

/** Resolve a composite read from one online snapshot without redirecting live writers. */
export async function withOpenClawStateDatabaseReadSnapshot<T>(
  operation: () => Promise<T>,
  options: OpenClawStateDatabaseOptions & {
    admissionTimeoutMs?: number;
    reuseCleanClose?: boolean;
  } = {},
): Promise<T> {
  const pathname = resolveReadOnlyPath(options);
  const current = stateSnapshotReads.getStore();
  if ((current?.active && current.path === pathname) || !existingPathOrUndefined(pathname)) {
    return await operation();
  }
  const env = options.env ?? process.env;
  const callerSignal = getAsyncWorkSignal();
  const controller = new AbortController();
  const admissionSignal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const assertHostAdmission = () =>
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  let closeSnapshotWork: ((reason: unknown) => void) | undefined;
  const run = async () => {
    let admission: ReturnType<typeof captureOpenClawStateDatabaseReadAdmission>;
    let prepared: AsyncPreparedSqliteReadOnlyLocation;
    let cleanClose = false;
    try {
      // Wait only before capturing private bytes; callbacks and cleanup must never replay.
      admission = await acquireWithWait({
        acquire: () => {
          admissionSignal.throwIfAborted();
          assertHostAdmission();
          return captureOpenClawStateDatabaseReadAdmission(pathname);
        },
        shouldRetry: (error) =>
          error instanceof StateDatabaseAdmissionPendingError && error.databasePath === pathname,
        deadlineMs: performance.now() + (options.admissionTimeoutMs ?? 0),
        pollIntervalMs: 250,
        sleep: (ms) => sleepWithAbort(ms, admissionSignal),
      });
      admissionSignal.throwIfAborted();
      cleanClose = options.reuseCleanClose === true && readSqliteDatabaseCleanClose(pathname);
      if (cleanClose) {
        prepared = { location: pathname, cleanupAsync: async () => true };
      } else if (
        isArtifactPreservingStateRead() &&
        maintenanceOwnerMayCopySourcesInProcess(getOpenClawDatabaseMaintenanceScope(), pathname) &&
        !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(pathname)
      ) {
        prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
      } else {
        prepared = await prepareSqliteReadOnlyLocation(pathname, {
          preserveSourceArtifacts: isArtifactPreservingStateRead(),
          signal: controller.signal,
        });
      }
    } catch (error) {
      throw new Error(
        `Cannot read shared state for discovery: ${pathname}. Retry after the current state operation completes. ${String(error)}`,
        { cause: error },
      );
    }
    const releaseSource = cleanClose
      ? () => {}
      : retainSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
    let readSucceeded = false;
    const snapshot = Object.assign(
      createRetainedReadScope(pathname, admission.identity, async () => {
        releaseSource();
        let cause: unknown;
        try {
          if (await prepared.cleanupAsync()) {
            return;
          }
        } catch (error) {
          if (
            readSucceeded &&
            !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources &&
            error instanceof SqliteSnapshotCleanupError &&
            hasErrnoCode(error.cause, "EBUSY")
          ) {
            // Logical close can precede native release on Bun Windows. The
            // snapshot registry keeps these private bytes for later cleanup.
            getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
              { path: prepared.cleanupRoot, errorCode: "EBUSY" },
              "Discovery snapshot cleanup deferred until native SQLite resources are released.",
            );
            return;
          }
          cause = error;
        }
        throw new SqliteSnapshotCleanupError(
          `Shared-state discovery snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
          { cause },
        );
      }),
      {
        location: prepared.location,
        cleanupRoot: prepared.cleanupRoot,
        env,
        cleanClose,
      },
    );
    const lifecycle = stateSnapshotReads.run(snapshot, () => bindRetainedReadScope(snapshot));
    closeSnapshotWork = lifecycle.abort;
    const closeFromCaller = () => lifecycle.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", closeFromCaller, { once: true });
    if (callerSignal?.aborted) {
      closeFromCaller();
    }
    try {
      return await lifecycle.run(async () => {
        controller.signal.throwIfAborted();
        assertHostAdmission();
        admission.assertCurrent();
        const result = await operation();
        readSucceeded = true;
        return result;
      });
    } finally {
      callerSignal?.removeEventListener("abort", closeFromCaller);
    }
  };
  return await retainSnapshotWork(run(), () => {
    controller.abort(new Error("Shared-state snapshot admission closed"));
    closeSnapshotWork?.(controller.signal.reason);
  });
}

/** The caller owns this private database and removes its files after the scope closes. */
export async function withDisposableOpenClawStateReads<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedPath = resolveReadOnlyPath({ path: pathname });
  const scope = createRetainedReadScope(
    resolvedPath,
    captureOpenClawStateDatabaseReadAdmission(resolvedPath).identity,
  );
  return await runRetainedReadScope(scope, () =>
    disposableStateReads.run([...(disposableStateReads.getStore() ?? []), scope], operation),
  );
}

function requiresArtifactPreservingSnapshot(pathname: string): boolean {
  return (
    isArtifactPreservingStateRead("shared", pathname) &&
    !isUpdateRehearsalPrivateDatabase(pathname, process.env) &&
    !disposableStateReads.getStore()?.some((scope) => scope.active && scope.path === pathname)
  );
}

type ScopedRead = ReturnType<typeof openOpenClawStateReadOnlyLocation>;
const synchronousReadSnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.synchronousStateReadSnapshots"),
  (): { current: Map<string, ScopedRead> | undefined; currentAuthorityPath?: string } => ({
    current: undefined,
  }),
);

/** One synchronous metadata operation shares private bytes, never later admission reads. */
export function withSynchronousArtifactPreservingStateSnapshot<T>(
  operation: () => T,
  options?: { current?: OpenClawStateDatabaseOptions },
): T {
  if (options?.current) {
    // Check inherited admission before selecting fresh bytes for this assertion.
    const pathname = resolveReadOnlyPath(options.current);
    const inherited = synchronousReadSnapshots.current;
    const inheritedAuthority = synchronousReadSnapshots.currentAuthorityPath;
    if (inherited && inheritedAuthority === pathname) {
      // A composite assertion already selected fresh bytes for this database.
      return operation();
    }
    return stateSnapshotReads.exit(() => {
      synchronousReadSnapshots.current = undefined;
      synchronousReadSnapshots.currentAuthorityPath = pathname;
      try {
        return withArtifactPreservingStateReads(() =>
          withSynchronousArtifactPreservingStateSnapshot(operation),
        );
      } finally {
        synchronousReadSnapshots.current = inherited;
        synchronousReadSnapshots.currentAuthorityPath = inheritedAuthority;
      }
    });
  }
  if (!isArtifactPreservingStateRead() || synchronousReadSnapshots.current) {
    return operation();
  }
  const readers = new Map<string, ScopedRead>();
  synchronousReadSnapshots.current = readers;
  return runSynchronousReadScope(
    {
      readers,
      leave: () => {
        synchronousReadSnapshots.current = undefined;
      },
    },
    operation,
  );
}

function resolveReadOnlyPath(options: OpenClawStateDatabaseOptions): string {
  const pathname = resolveDatabasePath(options);
  assertRetainedReadScopeAdmission(pathname, [
    stateSnapshotReads.getStore(),
    ...(disposableStateReads.getStore() ?? []),
  ]);
  isExistingOpenClawStateSchema(pathname);
  return pathname;
}

function withOpenClawStateDatabaseReadOnlyIfOpen<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  currentAuthority = false,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const snapshot = stateSnapshotReads.getStore();
  if (snapshot?.active && snapshot.path === pathname) {
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
      pathname,
      snapshot.env,
    );
    return {
      reused: true,
      value: withOpenClawStateReadOnlyLocation(
        operation,
        pathname,
        snapshot.cleanClose ? resolveImmutableSqliteFileUri(snapshot.location) : snapshot.location,
      ),
    };
  }
  if (
    isArtifactPreservingStateRead("agent", pathname) &&
    (requiresArtifactPreservingSnapshot(pathname) ||
      isUpdateRehearsalPrivateDatabase(pathname, process.env))
  ) {
    return { reused: false };
  }
  return withCachedOpenClawStateDatabaseReadOnly(
    operation,
    pathname,
    currentAuthority || synchronousReadSnapshots.currentAuthorityPath === pathname,
  );
}

function withFreshOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  pathname: string,
): T {
  const env = options.env ?? process.env;
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  if (synchronousReadSnapshots.currentAuthorityPath === pathname) {
    const maintained = withMaintenanceOpenClawStateDatabaseReadOnly(operation, pathname);
    if (maintained.reused) {
      return maintained.value;
    }
  }
  // Even read-only SQLite opens can create a missing WAL. The existing worker
  // snapshots committed WAL pages without touching source sidecars or caller-held locks.
  // One consistent snapshot per synchronous scope avoids mixed reads and duplicate copies.
  // Concurrent commits become visible in the next scope; this reader closes at scope end.
  const readers = synchronousReadSnapshots.current;
  if (readers && requiresArtifactPreservingSnapshot(pathname)) {
    let opened = readers.get(pathname);
    if (!opened) {
      opened = openOpenClawStateReadOnlyLocation(
        pathname,
        prepareSqliteReadOnlyLocationSync(pathname),
      );
      readers.set(pathname, opened);
    }
    assertStateReadSchema(opened.database.db, pathname);
    const result = operation(opened.database);
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite metadata snapshot read must remain synchronous");
    }
    return result;
  }
  const prepared = requiresArtifactPreservingSnapshot(pathname)
    ? prepareSqliteReadOnlyLocationSync(pathname)
    : undefined;
  return withOpenClawStateReadOnlyLocation(operation, pathname, prepared ?? pathname);
}

/** Read shared state without joining writers; admission inherits artifact preservation. */
export function withOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const pathname = resolveReadOnlyPath(options);
  // Reusing a handle this process already holds keeps row loops cheap: opening
  // and closing a connection per call made shared-state reads scale with row
  // count. An in-flight transaction is skipped so callers never observe
  // uncommitted rows a fresh read-only connection could not have seen.
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
}

/** A missing pathname is not absence while this read owner can serve retained state. */
export function isOpenClawStateDatabaseDefinitelyAbsent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const pathname = resolveReadOnlyPath({ env });
    const snapshot = stateSnapshotReads.getStore();
    if (
      synchronousReadSnapshots.current?.has(pathname) ||
      (snapshot?.active && snapshot.path === pathname) ||
      openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname)?.db.isOpen
    ) {
      return false;
    }
    try {
      lstatSync(pathname);
      return false;
    } catch (error) {
      return hasErrnoCode(error, "ENOENT");
    }
  } catch {
    // Unknown availability retains the normal reader's admission and error behavior.
    return false;
  }
}

/** Read existing shared state while preserving non-missing filesystem failures. */
export function withExistingOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  const existingPath = existingPathOrUndefined(pathname);
  return existingPath === undefined
    ? undefined
    : withFreshOpenClawStateDatabaseReadOnly(operation, options, existingPath);
}

/** Fixed reads observe committed state unless their owner explicitly selected a snapshot. */
export function executeExistingOpenClawStateRead(
  options: OpenClawStateDatabaseOptions,
  command: OpenClawStateReadCommand,
  readOptions: OpenClawStateReadOptions = {},
): Promise<OpenClawStateReadReply | undefined> {
  const { context, current, live, mapError } = readOptions;
  const receipt: OpenClawStateReadReceipt = { phase: "before-read" };
  let completion: OpenClawStateReadCompletion;
  try {
    context?.admission.assertCurrent();
    const execute = () => startRetainedOpenClawStateRead(options, command, receipt, readOptions);
    // Active writer observations use the retained worker connection, not a new
    // artifact-preserving copy. Admission and canonical close still own it.
    const read = live
      ? () => artifactPreservingReads.run(false, () => stateSnapshotReads.exit(execute))
      : current
        ? () => stateSnapshotReads.exit(execute)
        : execute;
    completion = context?.runInCapturedSchemaScope
      ? context.runInCapturedSchemaScope(read)
      : read();
  } catch (error) {
    throw mapError ? mapError(error, receipt.phase) : error;
  }
  return completion.kind === "retained" ? completion.operation.result : completion.result;
}

function startRetainedOpenClawStateRead(
  options: OpenClawStateDatabaseOptions,
  command: OpenClawStateReadCommand,
  receipt: OpenClawStateReadReceipt,
  {
    context: capturedContext,
    signal,
    current,
    live,
    mapError,
    preferIndependentWarmRead,
    onChunk,
    onChunkAsync,
  }: OpenClawStateReadOptions,
): OpenClawStateReadCompletion {
  const currentRead = current || live;
  const pathname = resolveReadOnlyPath(options);
  const inherited = stateSnapshotReads.getStore();
  const snapshot = inherited?.active && inherited.path === pathname ? inherited : undefined;
  const scopes: RetainedReadScope[] = [
    ...(snapshot ? [snapshot] : []),
    ...(disposableStateReads.getStore() ?? []).filter(
      (scope) => scope.active && scope.path === pathname,
    ),
  ];
  const env = snapshot?.env ?? options.env;
  const context = capturedContext ?? captureOpenClawStateReadWorkerContext({ path: pathname, env });
  if (capturedContext) {
    if (context.admission.databasePath !== pathname) {
      throw new Error("Shared-state read context does not match its selected source");
    }
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  }
  const preserveArtifacts = requiresArtifactPreservingSnapshot(pathname);
  const controller = new AbortController();
  const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const run = () => {
    const inheritedSource = currentRead
      ? undefined
      : synchronousReadSnapshots.current?.get(pathname)?.snapshotSource?.retain();
    return startOpenClawStateReadOperation(command, {
      pathname,
      snapshot: inheritedSource ?? snapshot,
      scopes,
      context,
      preserveArtifacts,
      preferIndependentWarmRead,
      onChunk,
      onChunkAsync,
      controller,
      signal: readSignal,
      receipt,
      mapError,
    });
  };
  // Enter the same frames as tracked async work, but keep its retained result independent
  // of the bookkeeping promises used by scope drains.
  const tracked = scopes.reduceRight<() => OpenClawStateReadCompletion>(
    (operation, scope) => () =>
      scope.work.run(() => {
        const completion = operation();
        const result =
          completion.kind === "retained" ? completion.operation.result : completion.result;
        void scope.work.track(() => result).catch(() => undefined);
        return completion;
      }),
    run,
  );
  const maintenance = context.maintenanceScope;
  let completion: OpenClawStateReadCompletion | undefined;
  if (maintenance) {
    // Maintenance keeps this captured frame active until the callback's Promise settles.
    void maintenance.run(() => {
      const accepted = tracked();
      completion = accepted;
      return accepted.kind === "retained" ? accepted.operation.result : accepted.result;
    });
  } else {
    completion = tracked();
  }
  if (!completion) {
    throw new Error("Shared-state read maintenance scope did not start its operation");
  }
  const result = completion.kind === "retained" ? completion.operation.result : completion.result;
  void retainSnapshotWork(result, () =>
    controller.abort(new Error("Shared-state read admission closed")),
  );
  return completion;
}

/** Read existing shared state without creating or updating its SQLite sidecars. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T | undefined {
  if (openStateSchemaReadAdmission) {
    return withExistingOpenClawStateDatabaseCurrentReadOnly(
      operation,
      options,
      openStateSchemaReadAdmission,
    );
  }
  return withArtifactPreservingStateReads(() =>
    withExistingOpenClawStateDatabaseReadOnly(operation, options),
  );
}

/** Publication guards need current rows, never an inherited discovery snapshot. */
export function withExistingOpenClawStateDatabaseCurrentReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions & {
    /** Existing host mutation guards may read natively outside worker admission grants. */
    allowNativeRead?: true;
  } = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  return stateSnapshotReads.exit(() => {
    // Maintenance admission belongs to a fresh private reader, never a cached writer.
    if (!openStateSchemaReadAdmission) {
      const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname, true);
      if (reused.reused) {
        return reused.value;
      }
    }
    if (existingPathOrUndefined(pathname) === undefined) {
      return undefined;
    }
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
      pathname,
      options.env ?? process.env,
    );
    return withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      options.allowNativeRead && !isArtifactPreservingStateRead() && !openStateSchemaReadAdmission
        ? pathname
        : prepareSqliteReadOnlyLocationSync(pathname),
      openStateSchemaReadAdmission,
    );
  });
}

/** Preserve source artifacts while allowing the caller to progress during snapshot preparation. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T | undefined> {
  return withArtifactPreservingStateReads(async () => {
    const pathname = resolveReadOnlyPath(options);
    const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
    if (reused.reused) {
      return reused.value;
    }
    if (existingPathOrUndefined(pathname) === undefined) {
      return undefined;
    }
    const env = options.env ?? process.env;
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    if (!requiresArtifactPreservingSnapshot(pathname)) {
      return withOpenClawStateReadOnlyLocation(operation, pathname, pathname);
    }
    const prepared = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
    });
    try {
      // Verification can quarantine the live path while the snapshot child is running.
      openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    } catch (error) {
      prepared.cleanup();
      throw error;
    }
    return withOpenClawStateReadOnlyLocation(operation, pathname, prepared);
  });
}

export function readCurrentOpenClawStateDatabaseContentVersion(
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  const pathname = resolveReadOnlyPath(options);
  const env = options.env ?? process.env;
  return stateSnapshotReads.exit(() => readAdmittedStateContentVersion(pathname, env));
}

/** Current guards leave discovery snapshots after validating their inherited read admission. */
export function withCurrentOpenClawStateReadScope<T>(
  options: OpenClawStateDatabaseOptions,
  operation: (pathname: string) => T,
): T {
  const pathname = resolveReadOnlyPath(options);
  return stateSnapshotReads.exit(() => operation(pathname));
}
