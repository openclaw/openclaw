// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
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
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  try {
    signal?.throwIfAborted();
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
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, undefined, signal);
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
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal },
  signal: AbortSignal | undefined,
  asynchronousCleanup: boolean,
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  if (asynchronousCleanup) {
    assertStateDatabaseSourceReadContext(pathname);
  }
  return prepareSingleFlightSqliteSnapshot(
    pathname,
    `${options.preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${options.signal ? "strict" : "best-effort"}:${asynchronousCleanup ? "async-token" : "sync-token"}`,
    async (flightSignal, recordCleanupFailure) => {
      let stagingRoot: string | undefined;
      try {
        flightSignal.throwIfAborted();
        stagingRoot = await createSqliteSnapshotStagingDirectory(
          undefined,
          false,
          flightSignal,
          asynchronousCleanup,
        );
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
        if (
          error instanceof SqliteSnapshotCleanupError ||
          (asynchronousCleanup && error instanceof AggregateError)
        ) {
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
): PreparedSqliteReadOnlyLocation {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    return prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  }
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
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
      return prepared
        ? await operation(prepared.location)
        : await withSqliteSourceHandleAsync(pathname, () => operation(pathname));
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
