import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import type {
  NodeBootstrapArtifactWorkerInput,
  NodeBootstrapArtifactWorkerTasks,
} from "./node-bootstrap-artifact-contract.js";

serveWorkerTasks<
  NodeBootstrapArtifactWorkerTasks[keyof NodeBootstrapArtifactWorkerTasks]["output"],
  NodeBootstrapArtifactWorkerInput
>(async ({ kind, input }) => {
  if (kind === "bundle") {
    const { prepareWorkerBundle } = await import("./bundle.js");
    return await prepareWorkerBundle(input);
  }
  const { prepareNodeBootstrapArtifact } = await import("./node-bootstrap-artifact-build.js");
  const { options, temporaryRoot } = input;
  return await prepareNodeBootstrapArtifact(options, temporaryRoot);
});
