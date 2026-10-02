import { AsyncLocalStorage } from "node:async_hooks";
// Select an owned snapshot or native reader while retaining snapshot cleanup.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { createRetainedOperation, type RetainedOperation } from "./retained-operation.js";
import { prepareSqliteSnapshotFromLiveOwner } from "./sqlite-live-snapshot.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  adoptPreparedLocation,
  adoptRetainedPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "./sqlite-readonly-location.types.js";
import {
  resolveSqliteInspectionSignal,
  captureSqliteReadOnlyWorkerLaunch,
  isSqliteInspectionDeadlineOwnedByCaller,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
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

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: {
    preserveSourceArtifacts?: boolean;
    signal?: AbortSignal;
    /** A dedicated reader pins its transaction without borrowing a live writer's connection. */
    allowLiveOwner?: boolean;
  } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  try {
    signal?.throwIfAborted();
    if (!options.preserveSourceArtifacts && options.allowLiveOwner !== false) {
      const owned = prepareSqliteSnapshotFromLiveOwner(pathname, signal);
      if (owned) {
        return await owned;
      }
    }
    // The worker path preserves cleanup failures ahead of cancellation.
    return prepareWorkerSnapshot(pathname, options, signal);
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
  const preserveSourceArtifacts = options.preserveSourceArtifacts === true;
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
    (flightSignal, recordCleanupFailure) =>
      runInContext(() => {
        let task: ReturnType<typeof staging.start> | undefined;
        let prepared:
          | (PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation)
          | undefined;
        let cleanup: RetainedOperation<boolean> | undefined;
        const retained = createRetainedOperation<
          PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation
        >(() =>
          runInContext(() => {
            if (retained.operation.read().status !== "pending") {
              return;
            }
            if (!task) {
              return;
            }
            try {
              task.service();
              const outcome = task.read();
              if (outcome.status === "pending") {
                return;
              }
              if (outcome.status === "rejected") {
                if (
                  outcome.error instanceof SqliteSnapshotCleanupError ||
                  outcome.error instanceof AggregateError
                ) {
                  recordCleanupFailure(outcome.error);
                  throw outcome.error;
                }
                flightSignal.throwIfAborted();
                throw outcome.error;
              }
              if (outcome.value.type !== "prepared") {
                throw new Error(
                  "SQLite snapshot producer returned an allocation without its prepared location",
                );
              }
              prepared ??= adoptRetainedPreparedLocation(
                outcome.value.location,
                outcome.value.directory,
                requireCleanup,
              );
              if (flightSignal.aborted) {
                if (!cleanup) {
                  cleanup = prepared.startCleanup();
                  void cleanup.result.then(
                    () => retained.operation.service(),
                    () => retained.operation.service(),
                  );
                }
                cleanup.service();
                const removed = cleanup.read();
                if (removed.status === "pending") {
                  return;
                }
                if (removed.status === "rejected" || !removed.value) {
                  const error =
                    removed.status === "rejected"
                      ? removed.error
                      : new SqliteSnapshotCleanupError(
                          `SQLite snapshot cleanup failed: ${prepared.cleanupRoot}`,
                        );
                  recordCleanupFailure(error);
                  throw error;
                }
                flightSignal.throwIfAborted();
              }
              retained.resolve(prepared);
            } catch (error) {
              retained.reject(error);
            }
          }),
        );
        try {
          task = staging.start(
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
          void task.result.then(
            () => retained.operation.service(),
            () => retained.operation.service(),
          );
        } catch (error) {
          retained.reject(error);
        }
        return {
          ...retained.operation,
          startClose(): RetainedOperation<void> {
            const original = task;
            if (original) {
              return runInContext(() => original.startClose());
            }
            // A synchronous staging admission refusal accepted no request or native work.
            const closed = createRetainedOperation<void>(() => {});
            closed.resolve(undefined);
            return closed.operation;
          },
        };
      }),
    signal,
    { scope: staging },
  );
}

function prepareWorkerSnapshot(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal },
  signal: AbortSignal | undefined,
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  return prepareSingleFlightSqliteSnapshot(
    pathname,
    `${options.preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${options.signal ? "strict" : "best-effort"}:sync-token`,
    async (flightSignal, recordCleanupFailure) => {
      let stagingRoot: string | undefined;
      try {
        flightSignal.throwIfAborted();
        stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, flightSignal);
        flightSignal.throwIfAborted();
        const location = await runSqliteReadOnlyWorker(pathname, {
          mode: options.preserveSourceArtifacts ? "sync" : "async",
          signal: flightSignal,
          stagingRoot,
        });
        flightSignal.throwIfAborted();
        return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
      } catch (error) {
        if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
          const failure = new SqliteSnapshotCleanupError(
            `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
            { cause: error },
          );
          recordCleanupFailure(failure);
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
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
  captureContentVersion = false,
): PreparedSqliteReadOnlyLocation & { contentVersion?: string } {
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    if (captureContentVersion) {
      const snapshot = runSqliteReadOnlyWorkerSync(pathname, stagingRoot, "sync-versioned");
      return {
        ...adoptPreparedLocation(snapshot.location, stagingRoot),
        contentVersion: snapshot.contentVersion || undefined,
      };
    }
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
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
    try {
      return prepared ? await operation(prepared.location) : await operation(pathname);
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    await prepared?.cleanupAsync();
  }
}

/** Fresh bytes without opening SQLite or making another durable private copy. */
export function readSqliteSourceContentVersionSync(pathname: string): string | undefined {
  // Raw descriptor closes stay in the child so the writer's native SQLite locks remain held.
  return runSqliteReadOnlyWorkerSync(pathname, undefined, "content-version") || undefined;
}
