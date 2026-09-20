// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { prepareSqliteSnapshotFromLiveOwner } from "./sqlite-live-snapshot.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  PreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.types.js";
import {
  resolveSqliteInspectionSignal,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
} from "./sqlite-readonly-worker.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";
import {
  assertSqliteSourceReadAllowed,
  withSqliteSourceHandleAsync,
} from "./sqlite-source-handle.js";
import {
  assertStateDatabaseSourceReadContext,
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseCanonicalMutation,
  prepareStateDatabaseMutationSnapshot,
} from "./state-database-coordinator.js";

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal; stagingRoot?: string } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  try {
    signal?.throwIfAborted();
    if (options.stagingRoot && prepareStateDatabaseCanonicalMutation(pathname)) {
      throw new Error(
        "Caller-owned SQLite snapshot staging requires a drained canonical mutation owner.",
      );
    }
    const ownedSnapshot = prepareStateDatabaseMutationSnapshot(pathname, signal);
    if (ownedSnapshot) {
      const prepared = await ownedSnapshot;
      try {
        signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    if (hasStateDatabaseSourceExclusion(pathname)) {
      const prepared = options.preserveSourceArtifacts
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname, options.stagingRoot)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, options.stagingRoot, signal);
      try {
        signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    assertSqliteSourceReadAllowed(pathname);
    if (!options.preserveSourceArtifacts) {
      const owned = prepareSqliteSnapshotFromLiveOwner(pathname, signal);
      if (owned) {
        return await owned;
      }
    }
    // The worker path preserves cleanup failures ahead of cancellation.
    return prepareWorkerSnapshot(pathname, options, signal, false);
  } catch (error) {
    // Unsettled snapshot work retains precedence over caller cancellation.
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    signal?.throwIfAborted();
    throw error;
  }
}

/** Fixed worker readers hold their own token until their private native reader closes. */
export function prepareSqliteReadOnlyLocationAsync(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal } = {},
): Promise<AsyncPreparedSqliteReadOnlyLocation> {
  if (
    prepareStateDatabaseCanonicalMutation(pathname) ||
    hasStateDatabaseSourceExclusion(pathname)
  ) {
    throw new Error("SQLite source requires its existing snapshot owner");
  }
  return prepareWorkerSnapshot(
    pathname,
    options,
    resolveSqliteInspectionSignal(options.signal),
    true,
  );
}

function prepareWorkerSnapshot(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal; stagingRoot?: string },
  signal: AbortSignal | undefined,
  asynchronousCleanup: boolean,
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  if (asynchronousCleanup) {
    assertStateDatabaseSourceReadContext(pathname);
  }
  const produceSnapshot = async (
    flightSignal?: AbortSignal,
    recordCleanupFailure?: (error: unknown) => void,
  ): Promise<PreparedSqliteReadOnlyLocation> => {
    let stagingRoot: string | undefined;
    try {
      flightSignal?.throwIfAborted();
      stagingRoot = await createSqliteSnapshotStagingDirectory(
        options.stagingRoot,
        false,
        flightSignal,
        asynchronousCleanup,
      );
      flightSignal?.throwIfAborted();
      const location = await runSqliteReadOnlyWorker(pathname, {
        mode: options.preserveSourceArtifacts ? "sync" : "async",
        signal: flightSignal,
        stagingRoot,
      });
      flightSignal?.throwIfAborted();
      return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
    } catch (error) {
      // An unsettled worker may still write here. Preserve its custody failure
      // ahead of caller cancellation and leave the owned staging for recovery.
      if (hasCommandProcessCleanupError(error)) {
        recordCleanupFailure?.(error);
        throw error;
      }
      if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
        const failure = new SqliteSnapshotCleanupError(
          `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
          { cause: error },
        );
        recordCleanupFailure?.(failure);
        throw failure;
      }
      if (
        error instanceof SqliteSnapshotCleanupError ||
        (asynchronousCleanup && error instanceof AggregateError)
      ) {
        recordCleanupFailure?.(error);
        throw error;
      }
      flightSignal?.throwIfAborted();
      throw error;
    }
  };
  // Caller-owned recovery staging must not be shared with unrelated consumers.
  if (options.stagingRoot) {
    return produceSnapshot(signal);
  }
  return prepareSingleFlightSqliteSnapshot(
    pathname,
    `${options.preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${options.signal ? "strict" : "best-effort"}:${asynchronousCleanup ? "async-token" : "sync-token"}`,
    produceSnapshot,
    signal,
  );
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
  options: { fallbackToOnlineBackupUnderLoad?: boolean } = {},
): PreparedSqliteReadOnlyLocation {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    return prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  }
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    return adoptPreparedLocation(
      runSqliteReadOnlyWorkerSync(
        pathname,
        stagingRoot,
        options.fallbackToOnlineBackupUnderLoad ? "sync-fallback" : "sync",
      ),
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
  stagingRoot?: string,
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
  return await prepareSqliteReadOnlyLocation(canonicalPath, { stagingRoot });
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
  options: { stagingRoot?: string } = {},
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname, options.stagingRoot);
  try {
    try {
      return prepared
        ? await operation(prepared.location)
        : await withSqliteSourceHandleAsync(pathname, () => operation(pathname));
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname, options.stagingRoot);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    await prepared?.cleanupAsync();
  }
}
