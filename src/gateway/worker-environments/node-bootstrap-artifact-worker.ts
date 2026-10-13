import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  NodeBootstrapArtifact,
  NodeBootstrapArtifactOptions,
  NodeBootstrapArtifactWorkerInput,
} from "./node-bootstrap-artifact-contract.js";

export async function prepareNodeBootstrapArtifactInWorker(
  options: NodeBootstrapArtifactOptions,
  temporaryRoot: string,
): Promise<NodeBootstrapArtifact> {
  const pool = new WorkerTaskPool<NodeBootstrapArtifactWorkerInput, NodeBootstrapArtifact>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.nodeBootstrapArtifact),
    workerClass: "writer",
  });
  try {
    const artifact = await pool.run({ options, temporaryRoot }, {});
    // Structured cloning drops frozen descriptors at the worker boundary.
    return Object.freeze({
      ...artifact,
      enabledPluginIds: Object.freeze(artifact.enabledPluginIds),
    });
  } finally {
    // The provider may remove staging only after the builder has stopped writing.
    await pool.close();
  }
}
