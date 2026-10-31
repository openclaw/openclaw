import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { hasErrnoCode } from "../infra/errno.js";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import { retainSnapshotWork } from "../infra/sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { isUpdateRehearsalPrivateDatabase } from "../infra/update-rehearsal-paths.js";
import { runPluginSharedStateWork } from "../plugins/plugin-shared-state-admission.js";
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
import { assertStateFileSnapshotAllowed, isStatePostgres } from "./openclaw-state-db-engine.js";
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
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-maintenance-context.js";
import { postgresStateReadSnapshot } from "./openclaw-state-postgres-snapshot-context.js";
import {
  isStateReadReply,
  startOpenClawStateReadOperation,
  type OpenClawStateReadCompletion,
  type StateReadReply,
} from "./openclaw-state-read-operation.js";
import {
  assertRetainedReadScopeAdmission,
  bindRetainedReadScope,
  createRetainedReadScope,
  readRetainedStateSnapshot,
  runRetainedReadScope,
  runSynchronousReadScope,
} from "./openclaw-state-read-scope.js";
import {
  prepareOpenClawStateReadSnapshotSource,
  type StateReadSnapshotSource,
} from "./openclaw-state-read-snapshot-source.js";
import type {
  OpenClawStateReadReceipt,
  OpenClawStateReadOptions,
  OpenClawStateReadCommand,
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
        readSource(): StateReadSnapshotSource | undefined;
        prepareSource?: () => Promise<void>;
        forkSource: Awaited<
          ReturnType<typeof prepareOpenClawStateReadSnapshotSource>
        >["forkSource"];
        env: NodeJS.ProcessEnv;
        callerSignal?: AbortSignal;
      }
    >(),
);

function exitStateReadSnapshot<T>(operation: () => T): T {
  return stateSnapshotReads.exit(() => postgresStateReadSnapshot.exit(operation));
}

function resolveStateReadCallerSignal(): AbortSignal | undefined {
  const signal = getAsyncWorkSignal();
  const snapshot = stateSnapshotReads.getStore();
  // Snapshot drainage closes physical custody; only the caller can cancel an admitted read.
  return snapshot && signal === snapshot.work.signal ? snapshot.callerSignal : signal;
}

/** Stable identity and private bytes for reads within the enclosing snapshot scope. */
export function getActiveOpenClawStateDatabaseReadSnapshot(
  options: OpenClawStateDatabaseOptions = {},
): Readonly<{ location: string; cleanClose?: boolean }> | undefined {
  const current = stateSnapshotReads.getStore();
  return current?.path === resolveOpenClawStateReadPath(options) ? current.readSource() : undefined;
}

/** Prepare lazy snapshot bytes without blocking asynchronous discovery callers. */
export async function getActiveOpenClawStateDatabaseReadSnapshotAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<Readonly<{ location: string; cleanClose?: boolean }> | undefined> {
  const current = stateSnapshotReads.getStore();
  if (current?.path !== resolveOpenClawStateReadPath(options)) {
    return undefined;
  }
  // Retain preparation through cancellation/drainage, then recheck read admission
  // before publishing the same identity used by synchronous readers.
  return current.work.track(async () => {
    await current.prepareSource?.();
    resolveStateReadCallerSignal()?.throwIfAborted();
    return getActiveOpenClawStateDatabaseReadSnapshot(options);
  });
}

/** Fork only bytes already owned by this matching report, retaining it until the child settles. */
export async function forkActiveOpenClawStateDatabaseReadSnapshot(
  options: OpenClawStateDatabaseOptions = {},
) {
  const pathname = resolveOpenClawStateReadPath(options);
  const current = stateSnapshotReads.getStore();
  if (current?.path !== pathname) {
    return undefined;
  }
  assertRetainedReadScopeAdmission(pathname, [current]);
  const signal = resolveStateReadCallerSignal();
  signal?.throwIfAborted();
  return current.work.track(() => current.forkSource(signal));
}

/** Use a SQLite snapshot or the PostgreSQL read owner without redirecting live writers. */
export async function withOpenClawStateDatabaseReadSnapshot<T>(
  operation: () => Promise<T>,
  options: OpenClawStateDatabaseOptions & {
    admissionTimeoutMs?: number;
    reuseCleanClose?: boolean;
    /** Selected reports acquire shared bytes only when a reader actually needs them. */
    lazy?: boolean;
    /** Command owners may cancel preparation before the callback acquires its read scope. */
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const inheritedSignal = resolveStateReadCallerSignal();
  const callerSignal =
    options.signal && inheritedSignal
      ? AbortSignal.any([options.signal, inheritedSignal])
      : (options.signal ?? inheritedSignal);
  callerSignal?.throwIfAborted();
  const postgres = isStatePostgres();
  if (!postgres) {
    assertStateFileSnapshotAllowed();
  }
  const pathname = resolveOpenClawStateReadPath(options);
  const current = stateSnapshotReads.getStore();
  const lazy = options.lazy === true && !postgres;
  if (
    (current?.active && current.path === pathname) ||
    (!lazy && !existingPathOrUndefined(pathname))
  ) {
    return await operation();
  }
  const env = options.env ?? process.env;
  const controller = new AbortController();
  let closeSnapshotWork: ((reason: unknown) => void) | undefined;
  const run = async () => {
    const source = await prepareOpenClawStateReadSnapshotSource({
      pathname,
      env,
      postgres,
      lazy,
      controller,
      callerSignal,
      admissionTimeoutMs: options.admissionTimeoutMs,
      reuseCleanClose: options.reuseCleanClose,
    });
    let readSucceeded = false;
    const snapshot = Object.assign(
      createRetainedReadScope(pathname, source.identity, () => source.cleanup(readSucceeded)),
      {
        readSource: source.readSource,
        prepareSource: source.prepareSource,
        forkSource: source.forkSource,
        env,
        callerSignal,
      },
    );
    const bind = () => stateSnapshotReads.run(snapshot, () => bindRetainedReadScope(snapshot));
    const lifecycle = source.postgresSnapshot
      ? postgresStateReadSnapshot.run({ path: pathname, snapshot: source.postgresSnapshot }, bind)
      : bind();
    closeSnapshotWork = lifecycle.abort;
    const closeFromCaller = () => lifecycle.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", closeFromCaller, { once: true });
    if (callerSignal?.aborted) {
      closeFromCaller();
    }
    try {
      return await lifecycle.run(async () => {
        controller.signal.throwIfAborted();
        source.assertCurrent();
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
  const resolvedPath = resolveOpenClawStateReadPath({ path: pathname });
  const scope = createRetainedReadScope(
    resolvedPath,
    captureOpenClawStateDatabaseReadAdmission(resolvedPath).identity,
  );
  return await runRetainedReadScope(scope, () =>
    disposableStateReads.run([...(disposableStateReads.getStore() ?? []), scope], operation),
  );
}

function requiresArtifactPreservingSnapshot(pathname: string): boolean {
  // PostgreSQL reads use the admitted connection's read-only transaction, never a copied anchor.
  if (isStatePostgres()) {
    return false;
  }
  const required =
    isArtifactPreservingStateRead("shared", pathname) &&
    !isUpdateRehearsalPrivateDatabase(pathname, process.env) &&
    !disposableStateReads.getStore()?.some((scope) => scope.active && scope.path === pathname);
  if (required) {
    assertStateFileSnapshotAllowed();
  }
  return required;
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
    const pathname = resolveOpenClawStateReadPath(options.current);
    const inherited = synchronousReadSnapshots.current;
    const inheritedAuthority = synchronousReadSnapshots.currentAuthorityPath;
    if (inherited && inheritedAuthority === pathname) {
      // A composite assertion already selected fresh bytes for this database.
      return operation();
    }
    return exitStateReadSnapshot(() => {
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

export function resolveOpenClawStateReadPath(options: OpenClawStateDatabaseOptions): string {
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateReadPathCurrent(pathname);
  return pathname;
}

/** Prepared paths still honor the invoking reader and schema owner's live admission. */
export function assertOpenClawStateReadPathCurrent(pathname: string): void {
  const snapshot = stateSnapshotReads.getStore();
  const disposable = disposableStateReads.getStore();
  if (snapshot || disposable?.length) {
    assertRetainedReadScopeAdmission(pathname, [snapshot, ...(disposable ?? [])]);
  }
  isExistingOpenClawStateSchema(pathname);
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
    const source = snapshot.readSource();
    if (source) {
      return {
        reused: true,
        value: readRetainedStateSnapshot(snapshot, source, operation),
      };
    }
  }
  if (
    isArtifactPreservingStateRead("agent", pathname) &&
    (requiresArtifactPreservingSnapshot(pathname) ||
      isUpdateRehearsalPrivateDatabase(pathname, process.env))
  ) {
    return { reused: false };
  }
  if (isStatePostgres() && !currentAuthority) {
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
  // Maintenance must release readers before replacing store files.
  return withOpenClawStateReadOnlyLocation(
    operation,
    pathname,
    prepared ?? pathname,
    undefined,
    undefined,
    undefined,
    !isMainThread && !getOpenClawDatabaseMaintenanceScope(),
  );
}

/** Read shared state without joining writers; admission inherits artifact preservation. */
export function withOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const pathname = resolveOpenClawStateReadPath(options);
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
    const pathname = resolveOpenClawStateReadPath({ env });
    const snapshot = stateSnapshotReads.getStore();
    if (
      synchronousReadSnapshots.current?.has(pathname) ||
      (snapshot?.active && snapshot.path === pathname && snapshot.readSource()) ||
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
  const pathname = resolveOpenClawStateReadPath(options);
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
export function executeExistingOpenClawStateRead<Command extends OpenClawStateReadCommand>(
  options: OpenClawStateDatabaseOptions,
  command: Command,
  readOptions: OpenClawStateReadOptions = {},
): Promise<StateReadReply<Command["type"]> | undefined> {
  const type = command.type;
  const { context, current, live, mapError } = readOptions;
  const receipt: OpenClawStateReadReceipt = { phase: "before-read" };
  let completion: OpenClawStateReadCompletion;
  try {
    context?.admission.assertCurrent();
    const execute = () => startRetainedOpenClawStateRead(options, command, receipt, readOptions);
    // Active writer observations use the retained worker connection, not a new
    // artifact-preserving copy. Admission and canonical close still own it.
    const read = live
      ? () => artifactPreservingReads.run(false, () => exitStateReadSnapshot(execute))
      : current
        ? () => exitStateReadSnapshot(execute)
        : execute;
    completion = runPluginSharedStateWork(() =>
      context?.runInCapturedSchemaScope ? context.runInCapturedSchemaScope(read) : read(),
    );
  } catch (error) {
    throw mapError ? mapError(error, receipt.phase) : error;
  }
  return completion.then((reply) => {
    if (!reply || isStateReadReply(reply, type)) {
      return reply;
    }
    throw new Error(`Unexpected shared-state read reply for ${type}`);
  });
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
    snapshotPreparation,
    onChunk,
    onChunkAsync,
  }: OpenClawStateReadOptions,
): OpenClawStateReadCompletion {
  const currentRead = current || live;
  const pathname = resolveOpenClawStateReadPath(options);
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
  // Inspection inherits its deadline; ordinary background reads own explicit cancellation.
  const callerSignal =
    signal ??
    (isArtifactPreservingStateRead() ? resolveStateReadCallerSignal() : snapshot?.callerSignal);
  const readSignal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const run = () => {
    const inheritedSource = currentRead
      ? undefined
      : synchronousReadSnapshots.current?.get(pathname)?.snapshotSource?.retain();
    const start = () =>
      startOpenClawStateReadOperation(command, {
        pathname,
        snapshot: inheritedSource ?? snapshot?.readSource(),
        scopes,
        context,
        preserveArtifacts,
        preferIndependentWarmRead,
        snapshotPreparation,
        onChunk,
        onChunkAsync,
        controller,
        signal: readSignal,
        callerSignal,
        receipt,
        mapError,
      });
    if (snapshot?.prepareSource && !inheritedSource) {
      readSignal.throwIfAborted();
      return snapshot.prepareSource().then(
        () => {
          if (readSignal.aborted) {
            throw mapError ? mapError(readSignal.reason, receipt.phase) : readSignal.reason;
          }
          return start();
        },
        (error: unknown) => {
          throw mapError ? mapError(error, receipt.phase) : error;
        },
      );
    }
    return start();
  };
  // Enter the same frames as tracked async work, but keep its retained result independent
  // of the bookkeeping promises used by scope drains.
  const tracked = scopes.reduceRight<() => OpenClawStateReadCompletion>(
    (operation, scope) => () =>
      scope.work.run(() => {
        const completion = operation();
        void scope.work.track(() => completion).catch(() => undefined);
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
      return accepted;
    });
  } else {
    completion = tracked();
  }
  if (!completion) {
    throw new Error("Shared-state read maintenance scope did not start its operation");
  }
  void retainSnapshotWork(completion, () =>
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
  const pathname = resolveOpenClawStateReadPath(options);
  return exitStateReadSnapshot(() => {
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
    const directRead =
      (isStatePostgres() || options.allowNativeRead) &&
      !isArtifactPreservingStateRead() &&
      !openStateSchemaReadAdmission;
    if (!directRead) {
      assertStateFileSnapshotAllowed();
    }
    return withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      directRead ? pathname : prepareSqliteReadOnlyLocationSync(pathname),
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
    const pathname = resolveOpenClawStateReadPath(options);
    const snapshot = stateSnapshotReads.getStore();
    if (snapshot?.path === pathname && snapshot.prepareSource) {
      return snapshot.work.track(async () => {
        await snapshot.prepareSource!();
        resolveStateReadCallerSignal()?.throwIfAborted();
        const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
        return reused.reused ? reused.value : undefined;
      });
    }
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
  const pathname = resolveOpenClawStateReadPath(options);
  const env = options.env ?? process.env;
  return exitStateReadSnapshot(() => readAdmittedStateContentVersion(pathname, env));
}

/** Current guards leave discovery snapshots after validating their inherited read admission. */
export function withCurrentOpenClawStateReadScope<T>(
  options: OpenClawStateDatabaseOptions,
  operation: (pathname: string) => T,
): T {
  const pathname = resolveOpenClawStateReadPath(options);
  return exitStateReadSnapshot(() => operation(pathname));
}
