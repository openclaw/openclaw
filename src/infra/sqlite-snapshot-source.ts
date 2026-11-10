import { AsyncLocalStorage } from "node:async_hooks";
// Select an owned snapshot or native reader while retaining snapshot cleanup.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  createRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import {
  artifactPreservingReads,
  isArtifactPreservingStateRead,
} from "../state/artifact-preserving-state-reads.js";
import { getDatabaseEngineInput } from "./database-engine/context.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { SqliteSnapshotCleanupError } from "./sqlite-lifecycle-errors.js";
import { prepareSqliteSnapshotFromLiveOwner } from "./sqlite-live-snapshot.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { captureSqlitePrivateSnapshotFamily } from "./sqlite-private-snapshot-fork.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  registerRetainedSnapshotTempDirectory,
  retainSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  PreparedSqliteReadOnlyLocation,
  AsyncPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
  SqlitePrivateSnapshotFamily,
} from "./sqlite-readonly-location.types.js";
import {
  resolveSqliteInspectionSignal,
  captureSqliteReadOnlyWorkerLaunch,
  createScopedSqliteReadOnlyWorker,
  isSqliteInspectionDeadlineOwnedByCaller,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
  runSqliteReadOnlyWorkerOnce,
} from "./sqlite-readonly-worker.js";
import {
  bindReusableSqliteSource,
  captureFamily,
  captureReusableSqliteSource,
  createLeasedSqliteSnapshotPreparation,
  isSqliteSnapshotReuseActive,
  leaseReusableSqliteSnapshot,
  publishBoundReusableSqliteSnapshot,
  publishReusableSqliteSnapshot,
} from "./sqlite-snapshot-reuse.js";
import {
  prepareSingleFlightSqliteSnapshot,
  startSingleFlightSqliteSnapshot,
} from "./sqlite-snapshot-single-flight.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";
import {
  readDatabasePathIdentitySync,
  readDatabaseFileIdentity,
  type DatabaseFileIdentity,
  type DatabasePathIdentity,
} from "./sqlite-worker-identity.js";
import { isUpdateRehearsalPrivateDatabase } from "./update-rehearsal-paths.js";

type ArtifactReadScope = Exclude<
  ReturnType<typeof artifactPreservingReads.getStore>,
  false | undefined
>;

/** Aliases share a captured image only while they still name its physical source. */
function findArtifactSnapshot(scope: ArtifactReadScope, sourceIdentity: DatabasePathIdentity) {
  const snapshot = scope.snapshots.get(sourceIdentity.canonicalPath);
  if (
    snapshot &&
    (snapshot.sourceIdentity.key !== sourceIdentity.key ||
      snapshot.sourceIdentity.birthtime !== sourceIdentity.birthtime)
  ) {
    throw new Error("SQLite database file identity changed during inspection");
  }
  return snapshot;
}

/** The inspection scope owns private readers until native close and snapshot disposal settle. */
function retainArtifactSnapshot(
  scope: ArtifactReadScope,
  prepared: PreparedSqliteReadOnlyLocation,
  sourceIdentity: DatabasePathIdentity,
) {
  const releaseScope = retainSnapshotTempDirectory(
    prepared.cleanupRoot ?? path.dirname(prepared.location),
  );
  scope.privateRoots.add(prepared.cleanupRoot ?? path.dirname(prepared.location));
  const snapshot = {
    ...prepared,
    sourceIdentity,
    cleanup: () => {
      releaseScope();
      return prepared.cleanup();
    },
    cleanupAsync: () => {
      releaseScope();
      return prepared.cleanupAsync();
    },
  };
  scope.snapshots.set(sourceIdentity.canonicalPath, snapshot);
  return snapshot;
}

/** Borrow report-owned bytes through an awaited worker read; the report owns disposal. */
export function getArtifactPreservingSqliteRead(
  pathname: string,
): DatabasePathIdentity | undefined {
  const scope = artifactPreservingReads.getStore();
  if (!scope) {
    return undefined;
  }
  const sourceIdentity = readDatabasePathIdentitySync(pathname);
  const snapshot = findArtifactSnapshot(scope, sourceIdentity);
  if (!snapshot) {
    // The update driver already captured the entire disposable SQLite family.
    return isUpdateRehearsalPrivateDatabase(pathname, process.env) ? sourceIdentity : undefined;
  }
  return readDatabasePathIdentitySync(snapshot.location);
}

/** Prepare inspection bytes without changing the original-path reader's admission checks. */
export async function prepareArtifactPreservingSqliteRead(
  pathname: string,
  signal?: AbortSignal,
): Promise<void> {
  const scope = artifactPreservingReads.getStore();
  if (
    !scope ||
    getDatabaseEngineInput("agent") ||
    !isArtifactPreservingStateRead("agent", pathname) ||
    isUpdateRehearsalPrivateDatabase(pathname, process.env)
  ) {
    return;
  }
  const sourceIdentity = readDatabasePathIdentitySync(pathname);
  if (findArtifactSnapshot(scope, sourceIdentity)) {
    return;
  }
  const prepared = await prepareSqliteReadOnlyLocation(pathname, {
    preserveSourceArtifacts: true,
    signal,
    reuse: true,
    expectedSourceIdentity: sourceIdentity,
  });
  // Concurrent callers can join one producer; the report retains only one of its leases.
  if (scope.snapshots.has(sourceIdentity.canonicalPath)) {
    await prepared.cleanupAsync();
  } else {
    retainArtifactSnapshot(scope, prepared, sourceIdentity);
  }
}

/** The inspection scope owns private readers until native close and snapshot disposal settle. */
export function openSqliteReadOnlyDatabase(
  pathname: string,
  options: Parameters<typeof openNodeSqliteDatabase>[1] = {},
) {
  const scope = artifactPreservingReads.getStore();
  if (!scope || !isArtifactPreservingStateRead("agent", pathname)) {
    return openNodeSqliteDatabase(pathname, { ...options, readOnly: true });
  }
  // The published updater already prepared this image. Keep inspection read-only
  // and scoped, but do not copy the same database again for each canary check.
  const sourceIdentity = readDatabasePathIdentitySync(pathname);
  let snapshot = findArtifactSnapshot(scope, sourceIdentity);
  if (!snapshot && !isUpdateRehearsalPrivateDatabase(pathname, process.env)) {
    const prepared = prepareSqliteReadOnlyLocationSync(pathname);
    snapshot = retainArtifactSnapshot(scope, prepared, sourceIdentity);
  }
  const release = snapshot
    ? retainSnapshotTempDirectory(snapshot.cleanupRoot ?? path.dirname(snapshot.location))
    : undefined;
  const native: { close?: () => void } = {};
  const close = () => {
    native.close?.();
    release?.();
    scope.readers.delete(close);
  };
  scope.readers.add(close);
  const db = openNodeSqliteDatabase(snapshot?.location ?? pathname, { ...options, readOnly: true });
  const dispose = db.close.bind(db);
  native.close = () => {
    if (db.isOpen) {
      dispose();
    }
  };
  db.close = close;
  return db;
}

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: {
    preserveSourceArtifacts?: boolean;
    signal?: AbortSignal;
    /** A dedicated reader pins its transaction without borrowing a live writer's connection. */
    allowLiveOwner?: boolean;
    /** Throw removal failures with their cause instead of warning; a caller signal implies it. */
    requireCleanup?: boolean;
    /** Mutable consumers need exclusive bytes, including while preparation is in flight. */
    shared?: false;
    /** Read-only consumers may borrow an unchanged artifact-preserving image. */
    reuse?: true;
    expectedSourceIdentity?: DatabaseFileIdentity;
  } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  const preserveSourceArtifacts =
    options.preserveSourceArtifacts === true || isArtifactPreservingStateRead("agent", pathname);
  try {
    signal?.throwIfAborted();
    if (!preserveSourceArtifacts && options.allowLiveOwner !== false) {
      const owned = prepareSqliteSnapshotFromLiveOwner(pathname, signal);
      if (owned) {
        return await owned;
      }
    }
    // The worker path preserves cleanup failures ahead of cancellation.
    signal?.throwIfAborted();
    const reusable = options.reuse === true && preserveSourceArtifacts;
    const lease = reusable
      ? leaseReusableSqliteSnapshot(pathname, options.expectedSourceIdentity)
      : undefined;
    if (lease) {
      return lease;
    }
    const requireCleanup = options.requireCleanup ?? options.signal !== undefined;
    const flight = prepareSingleFlightSqliteSnapshot(
      pathname,
      `${preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${requireCleanup ? "strict" : "best-effort"}:sync-token${options.expectedSourceIdentity ? `:${JSON.stringify(options.expectedSourceIdentity)}` : ""}`,
      async (flightSignal, recordCleanupFailure) => {
        let stagingRoot: string | undefined;
        const source = reusable ? captureReusableSqliteSource(pathname) : undefined;
        try {
          flightSignal.throwIfAborted();
          stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, flightSignal);
          flightSignal.throwIfAborted();
          const location = await runSqliteReadOnlyWorker(pathname, {
            mode: preserveSourceArtifacts ? "sync" : "async",
            signal: flightSignal,
            stagingRoot,
            expectedSourceIdentity: options.expectedSourceIdentity,
          });
          flightSignal.throwIfAborted();
          bindReusableSqliteSource(location, source);
          const prepared = adoptPreparedLocation(location, stagingRoot, requireCleanup);
          if (reusable) {
            // A source too fresh to retain still gives its one reader a forkable family.
            prepared.privateFamily = captureFamily(prepared);
          }
          return prepared;
        } catch (error) {
          if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
            const failure = new SqliteSnapshotCleanupError(
              `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
              { cause: error },
            );
            recordCleanupFailure?.(failure);
            throw failure;
          }
          if (error instanceof SqliteSnapshotCleanupError) {
            recordCleanupFailure(error);
            throw error;
          }
          flightSignal.throwIfAborted();
          throw error;
        }
      },
      signal,
      options.shared === false ? { scope: {} } : undefined,
    );
    return reusable
      ? flight.then((prepared) =>
          // Synchronous: a following sync copy's space admission must see these bytes gone.
          publishBoundReusableSqliteSnapshot(pathname, prepared, () => prepared.cleanup()),
        )
      : flight;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

export function startSqliteReadOnlyLocationAsync(
  inputPathname: string,
  options: {
    preserveSourceArtifacts?: boolean;
    signal?: AbortSignal;
    expectedSourceIdentity?: DatabaseFileIdentity;
    /** Read-only consumers may borrow an unchanged artifact-preserving image. */
    reuse?: true;
  } = {},
): RetainedSqliteSnapshotPreparation {
  const signal = resolveSqliteInspectionSignal(options.signal);
  signal?.throwIfAborted();
  const pathname = path.resolve(inputPathname);
  const preserveSourceArtifacts =
    options.preserveSourceArtifacts === true || isArtifactPreservingStateRead("agent", pathname);
  const expectedSourceIdentity =
    options.expectedSourceIdentity === undefined
      ? undefined
      : readDatabaseFileIdentity(options.expectedSourceIdentity);
  if (expectedSourceIdentity && !preserveSourceArtifacts) {
    throw new Error("SQLite source identity requires artifact-preserving preparation");
  }
  // This producer's child owns its image, so it borrows but never leaves one behind.
  const lease =
    options.reuse && preserveSourceArtifacts
      ? leaseReusableSqliteSnapshot(pathname, expectedSourceIdentity)
      : undefined;
  if (lease) {
    return createLeasedSqliteSnapshotPreparation(lease);
  }
  const requireCleanup = options.signal !== undefined;
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const root = resolvePrivateSqliteSnapshotStagingRoot();
  const deadlineOwnedByCaller = isSqliteInspectionDeadlineOwnedByCaller();
  const staging = captureSqliteSnapshotStagingOwner();
  const runInContext = AsyncLocalStorage.snapshot();
  return startSingleFlightSqliteSnapshot(
    pathname,
    `${preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${requireCleanup ? "strict" : "best-effort"}:async-token${expectedSourceIdentity ? `:${JSON.stringify(expectedSourceIdentity)}` : ""}`,
    (flightSignal) =>
      runInContext(() => {
        const task = staging.start(
          {
            type: "prepare",
            root,
            pathname,
            allowLegacyWorker: false,
            preserveSourceArtifacts,
            expectedSourceIdentity,
            deadlineOwnedByCaller,
            launch: { env, cwd, transport: { kind: "native" } },
          },
          flightSignal,
        );
        return {
          ...mapRetainedOperation(task, (reply) => {
            if (reply.type !== "prepared") {
              throw new Error(
                "SQLite snapshot producer returned an allocation without its prepared location",
              );
            }
            const prepared = adoptPreparedLocation(reply.location, reply.directory, requireCleanup);
            // This producer lends only read-only images. Capture before flight publication:
            // another reader's last close can remove the WAL before a later borrower arrives.
            prepared.privateFamily = preserveSourceArtifacts
              ? captureSqlitePrivateSnapshotFamily(reply.location, reply.directory)
              : undefined;
            return prepared;
          }),
          startClose: () => task.startClose(),
        };
      }),
    signal,
    { scope: staging },
  );
}

/** Metadata selects live backup in a one-shot child; strict snapshots outside a reuse scope retain their raw-copy child. */
export async function prepareSqliteReadOnlyLocationAwaited(
  inputPathname: string,
  options: {
    signal: AbortSignal;
    expectedSourceIdentity: DatabaseFileIdentity;
    allowLiveOwner?: boolean;
    /** Read-only consumers may borrow an unchanged artifact-preserving image. */
    reuse?: true;
  },
): Promise<AsyncPreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  const pathname = path.resolve(inputPathname);
  const expectedSourceIdentity = readDatabaseFileIdentity(options.expectedSourceIdentity);
  // This producer's child owns its image, so it borrows but never leaves one behind.
  const lease = options.reuse
    ? leaseReusableSqliteSnapshot(pathname, expectedSourceIdentity)
    : undefined;
  if (lease) {
    return lease;
  }
  if (options.reuse && !options.allowLiveOwner && isSqliteSnapshotReuseActive()) {
    // A one-shot child leaves nothing behind, so this image can outlive its first reader.
    return prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
      signal,
      requireCleanup: true,
      reuse: true,
      expectedSourceIdentity,
    });
  }
  return prepareSingleFlightSqliteSnapshot(
    pathname,
    `worker-${options.allowLiveOwner ? "metadata" : "sync"}:strict:awaited-token:${JSON.stringify(expectedSourceIdentity)}`,
    async (flightSignal, recordCleanupFailure) => {
      const allowLiveOwner = options.allowLiveOwner;
      return useAwaitedSnapshotWorker(
        flightSignal,
        recordCleanupFailure,
        async (worker, directory) => {
          const request = {
            mode: allowLiveOwner ? ("metadata" as const) : ("sync" as const),
            stagingRoot: directory,
            expectedSourceIdentity,
            signal: flightSignal,
          };
          // Native backup completion must not share the staging owner's persistent IPC session.
          const location = allowLiveOwner
            ? await runSqliteReadOnlyWorkerOnce(pathname, request)
            : await worker.run(pathname, request);
          if (typeof location !== "string") {
            throw new Error("SQLite snapshot preparation returned an invalid location");
          }
          flightSignal.throwIfAborted();
          return adoptPreparedLocation(location, directory, true);
        },
      );
    },
    signal,
  );
}

async function useAwaitedSnapshotWorker<T>(
  signal: AbortSignal,
  recordCleanupFailure: ((error: unknown) => void) | undefined,
  inspect: (
    worker: ReturnType<typeof createScopedSqliteReadOnlyWorker>,
    directory: string,
  ) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const launch = captureSqliteReadOnlyWorkerLaunch();
  let worker = createScopedSqliteReadOnlyWorker({ ...launch, retainOnOperationError: true });
  let directory: string | undefined;
  let retirement: RetainedOperation<void> | undefined;
  const retire = (): RetainedOperation<void> => {
    if (retirement && retirement.read().status !== "rejected") {
      return retirement;
    }
    const completion = createRetainedOperation<void>(() => {});
    retirement = completion.operation;
    void (async () => {
      if (directory) {
        // A failed copy may have retired its child; recovery still runs outside the host.
        const recover = worker.isRetired();
        if (recover) {
          await worker.close();
          worker = createScopedSqliteReadOnlyWorker(launch);
        }
        await worker.run(directory, { mode: recover ? "staging-reconcile" : "staging-retire" });
      }
      await worker.close();
      await worker.closed;
      if (directory) {
        await fs.promises.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 20,
        });
      }
    })().then(completion.resolve, completion.reject);
    return retirement;
  };
  try {
    const allocated = await worker.run(resolvePrivateSqliteSnapshotStagingRoot(), {
      mode: "staging-create",
      signal,
    });
    if (typeof allocated !== "string") {
      throw new Error("SQLite snapshot allocation returned an invalid directory");
    }
    directory = allocated;
    registerRetainedSnapshotTempDirectory(directory, retire);
    signal.throwIfAborted();
    const value = await inspect(worker, directory);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    try {
      if (directory) {
        if (!(await removeTempDirectoryAsync(directory))) {
          throw new SqliteSnapshotCleanupError(`SQLite snapshot cleanup failed: ${directory}`);
        }
      } else {
        await worker.close();
        await worker.closed;
      }
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "SQLite snapshot preparation and cleanup failed",
      );
      recordCleanupFailure?.(failure);
      throw failure;
    }
    throw error;
  }
}

/** The retained read owner supplies the family before any native consumer can change its WAL. */
export async function forkSqlitePrivateSnapshot(
  pathname: string,
  family: SqlitePrivateSnapshotFamily,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<PreparedSqliteReadOnlyLocation> {
  return useAwaitedSnapshotWorker(signal, undefined, async (worker, directory) => {
    const location = await worker.run(pathname, {
      mode: "private-fork",
      family,
      stagingRoot: directory,
      signal,
    });
    if (typeof location !== "string") {
      throw new Error("SQLite private fork returned an invalid location");
    }
    signal.throwIfAborted();
    assertCurrent();
    return adoptPreparedLocation(location, directory);
  });
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
  expectedSourceIdentity?: DatabaseFileIdentity,
  options: {
    /** Read-only consumers may borrow an unchanged artifact-preserving image. */
    reuse?: true;
  } = {},
): PreparedSqliteReadOnlyLocation {
  const lease = options.reuse
    ? leaseReusableSqliteSnapshot(pathname, expectedSourceIdentity)
    : undefined;
  if (lease) {
    return lease;
  }
  const source = options.reuse ? captureReusableSqliteSource(pathname) : undefined;
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    const prepared = adoptPreparedLocation(
      runSqliteReadOnlyWorkerSync(pathname, stagingRoot, "sync", expectedSourceIdentity),
      stagingRoot,
    );
    return source
      ? publishReusableSqliteSnapshot(pathname, source, prepared, () => prepared.cleanup())
      : prepared;
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new SqliteSnapshotCleanupError(
        `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    // SAFETY: lstatSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    return await operation(prepared ? prepared.location : pathname);
  } catch (error) {
    if (prepared) {
      throw error;
    }
    prepared = await prepareSqliteSnapshotSource(pathname);
    if (!prepared) {
      throw error;
    }
    return await operation(prepared.location);
  } finally {
    await prepared?.cleanupAsync();
  }
}

/** Fresh bytes without opening SQLite or making another durable private copy. */
export function readSqliteSourceContentVersionSync(pathname: string): string | undefined {
  // Raw descriptor closes stay in the child so the writer's native SQLite locks remain held.
  return runSqliteReadOnlyWorkerSync(pathname, undefined, "content-version") || undefined;
}
