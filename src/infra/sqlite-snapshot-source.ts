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
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareSqliteSnapshotFromLiveOwner } from "./sqlite-live-snapshot.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { captureSqlitePrivateSnapshotFamily } from "./sqlite-private-snapshot-fork.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  registerRetainedSnapshotTempDirectory,
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
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
  prepareSingleFlightSqliteSnapshot,
  startSingleFlightSqliteSnapshot,
} from "./sqlite-snapshot-single-flight.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";
import { readDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";
import { isUpdateRehearsalPrivateDatabase } from "./update-rehearsal-paths.js";

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
  const snapshot = isUpdateRehearsalPrivateDatabase(pathname, process.env)
    ? undefined
    : prepareSqliteReadOnlyLocationSync(pathname);
  const release = snapshot
    ? retainSnapshotTempDirectory(snapshot.cleanupRoot ?? path.dirname(snapshot.location))
    : undefined;
  const native: { close?: () => void } = {};
  const close = () => {
    native.close?.();
    release?.();
    if (snapshot && !snapshot.cleanup()) {
      throw new SqliteSnapshotCleanupError("SQLite inspection snapshot cleanup failed.");
    }
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
    const requireCleanup = options.requireCleanup ?? options.signal !== undefined;
    return prepareSingleFlightSqliteSnapshot(
      pathname,
      `${preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${requireCleanup ? "strict" : "best-effort"}:sync-token`,
      async (flightSignal, recordCleanupFailure) => {
        let stagingRoot: string | undefined;
        try {
          flightSignal.throwIfAborted();
          stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, flightSignal);
          flightSignal.throwIfAborted();
          const location = await runSqliteReadOnlyWorker(pathname, {
            mode: preserveSourceArtifacts ? "sync" : "async",
            signal: flightSignal,
            stagingRoot,
          });
          flightSignal.throwIfAborted();
          return adoptPreparedLocation(location, stagingRoot, requireCleanup);
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
    );
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

/** Metadata selects live backup in a one-shot child; strict snapshots retain their raw-copy child. */
export async function prepareSqliteReadOnlyLocationAwaited(
  inputPathname: string,
  options: {
    signal: AbortSignal;
    expectedSourceIdentity: DatabaseFileIdentity;
    allowLiveOwner?: boolean;
  },
): Promise<AsyncPreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  const pathname = path.resolve(inputPathname);
  const expectedSourceIdentity = readDatabaseFileIdentity(options.expectedSourceIdentity);
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
): PreparedSqliteReadOnlyLocation {
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    return adoptPreparedLocation(
      runSqliteReadOnlyWorkerSync(pathname, stagingRoot, "sync", expectedSourceIdentity),
      stagingRoot,
    );
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
