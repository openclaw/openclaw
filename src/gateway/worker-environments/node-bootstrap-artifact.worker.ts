import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { prepareNodeBootstrapArtifact } from "./node-bootstrap-artifact-build.js";
import type { NodeBootstrapArtifactWorkerInput } from "./node-bootstrap-artifact-contract.js";

serveWorkerTasks(async (input) => {
  // SAFETY: the private producer supplies this typed request over its owned worker channel.
  const { options, temporaryRoot } = input as NodeBootstrapArtifactWorkerInput;
  return await prepareNodeBootstrapArtifact(options, temporaryRoot);
});
