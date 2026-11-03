import { settleSqliteSnapshotRequest } from "./sqlite-readonly-location-cleanup.js";
import { startWorkerOwnedSqliteSnapshotAllocation } from "./sqlite-snapshot-staging-allocation.js";
import type { SqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.types.js";

// Low-level token workers load the retained owner only when asynchronous staging is requested.
export async function allocateWorkerOwnedSqliteSnapshotDirectory(
  inputRoot: string,
  allowLegacyWorker: boolean,
  signal?: AbortSignal,
): Promise<SqliteSnapshotStagingDirectory> {
  const { owner, request } = startWorkerOwnedSqliteSnapshotAllocation(
    inputRoot,
    allowLegacyWorker,
    signal,
  );
  const reply = await settleSqliteSnapshotRequest(request);
  return owner.retainDirectory(reply.directory);
}
