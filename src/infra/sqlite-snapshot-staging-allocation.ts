import path from "node:path";
import { settleSqliteSnapshotRequest } from "./sqlite-readonly-location-cleanup.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import type { SqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.types.js";

export async function allocateWorkerOwnedSqliteSnapshotDirectory(
  inputRoot: string,
  allowLegacyWorker: boolean,
  signal?: AbortSignal,
): Promise<SqliteSnapshotStagingDirectory> {
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
  const reply = await settleSqliteSnapshotRequest(request);
  return owner.retainDirectory(reply.directory);
}
