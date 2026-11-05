import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { NodeBootstrapArtifactWorkerTasks } from "./node-bootstrap-artifact-contract.js";

export async function prepareNodeArtifactInWorker<
  Kind extends keyof NodeBootstrapArtifactWorkerTasks,
>(
  kind: Kind,
  input: NodeBootstrapArtifactWorkerTasks[Kind]["input"],
): Promise<NodeBootstrapArtifactWorkerTasks[Kind]["output"]> {
  const pool = new WorkerTaskPool<
    { kind: Kind; input: NodeBootstrapArtifactWorkerTasks[Kind]["input"] },
    NodeBootstrapArtifactWorkerTasks[Kind]["output"]
  >({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.nodeBootstrapArtifact),
    workerClass: "writer",
  });
  try {
    return await pool.run({ kind, input }, {});
  } finally {
    // The provider may remove staging only after the builder has stopped writing.
    await pool.close();
  }
}
