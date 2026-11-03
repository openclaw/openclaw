import path from "node:path";
import { settleSqliteSnapshotOperationSync } from "./sqlite-readonly-location-cleanup.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import type {
  SqliteSnapshotStagingDirectory,
  SqliteSnapshotStagingRequest,
} from "./sqlite-snapshot-staging.types.js";

export function startWorkerOwnedSqliteSnapshotAllocation(
  inputRoot: string,
  allowLegacyWorker: boolean,
  signal?: AbortSignal,
): {
  owner: ReturnType<typeof captureSqliteSnapshotStagingOwner>;
  request: SqliteSnapshotStagingRequest;
} {
  const root = path.resolve(inputRoot);
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const owner = captureSqliteSnapshotStagingOwner();
  const request = owner.start(
    {
      type: "allocate",
      root,
      allowLegacyWorker,
      launch: { env, cwd, transport: { kind: "native" } },
    },
    signal,
  );
  return { owner, request };
}

export function allocateWorkerOwnedSqliteSnapshotDirectorySync(
  inputRoot: string,
  allowLegacyWorker = false,
): SqliteSnapshotStagingDirectory {
  const { owner, request } = startWorkerOwnedSqliteSnapshotAllocation(inputRoot, allowLegacyWorker);
  try {
    return owner.retainDirectory(settleSqliteSnapshotOperationSync(request).directory);
  } catch (error) {
    try {
      settleSqliteSnapshotOperationSync(request.startClose());
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "SQLite snapshot allocation and cleanup failed",
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }
}
