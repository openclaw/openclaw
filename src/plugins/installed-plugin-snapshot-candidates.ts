import { runWithOpenClawStateLeaseWorker } from "../state/openclaw-state-lease-worker-operation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PluginMetadataLeaseContext } from "./plugin-lifecycle-lease.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";

/** This journal survives before the first installed-index row and never changes inventory. */
export async function updatePluginSnapshotCandidates(params: {
  stateDir: string;
  lease: PluginMetadataLeaseContext;
  operation: "read" | "retain" | "release";
  candidates?: readonly Omit<PluginSourceSnapshotDescriptor, "installedRevision">[];
}): Promise<PluginSourceSnapshotDescriptor[]> {
  const context = captureOpenClawStateWorkerContext({
    env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
  });
  return await runWithOpenClawStateLeaseWorker(
    params.lease.stateLease,
    context,
    (scope, identity) =>
      scope.execute({
        type: "plugins.metadata.index.snapshotCandidates",
        input: {
          identity,
          operation: params.operation,
          candidates: (params.candidates ?? []).map((entry) =>
            Object.assign({}, entry, { installedRevision: 0 }),
          ),
        },
      }),
    { assertCurrent: params.lease.assertCurrent, beforeCommit: params.lease.assertCurrent },
  );
}
