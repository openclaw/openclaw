// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import {
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  adoptPreparedLocation,
  createSqliteSnapshotStagingDirectory,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  removeTempDirectory,
  SQLITE_SNAPSHOT_STAGING_PREFIX,
  type PreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.js";
import { runSqliteReadOnlyWorker, runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import { withSqliteSourceHandleAsync } from "./sqlite-source-handle.js";
import {
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseMutationSnapshot,
} from "./state-database-coordinator.js";

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  let stagingRoot: string | undefined;
  try {
    options.signal?.throwIfAborted();
    const ownedSnapshot = prepareStateDatabaseMutationSnapshot(pathname);
    if (ownedSnapshot) {
      const prepared = await ownedSnapshot;
      try {
        options.signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        prepared.cleanup();
        throw error;
      }
    }
    if (hasStateDatabaseSourceExclusion(pathname)) {
      const prepared = options.preserveSourceArtifacts
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname)
        : await prepareSqliteReadOnlyLocationInProcess(pathname);
      try {
        options.signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        prepared.cleanup();
        throw error;
      }
    }
    // A stopped worker may never publish its random snapshot path. Allocate its
    // private parent first so cancellation can join the child and remove all copies.
    stagingRoot = await createSqliteSnapshotStagingDirectory();
    options.signal?.throwIfAborted();
    const location = await runSqliteReadOnlyWorker(pathname, {
      mode: options.preserveSourceArtifacts ? "sync" : "async",
      signal: options.signal,
      stagingRoot,
    });
    options.signal?.throwIfAborted();
    // Cancellable maintenance must retain its fence on cleanup failure; ordinary
    // read-only handles report false so their owner can retry close.
    return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
  } catch (error) {
    if (stagingRoot && !removeTempDirectory(stagingRoot)) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
    }
    options.signal?.throwIfAborted();
    throw error;
  }
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    return prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  }
  const stagingRoot = createPrivateSqliteTempDirectorySync(
    resolvePrivateSqliteSnapshotStagingRoot(),
    SQLITE_SNAPSHOT_STAGING_PREFIX,
  );
  try {
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
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
    prepared?.cleanup();
  }
}
