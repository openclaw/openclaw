import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoint } from "../infra/runtime-process-url.js";
import {
  WORKER_BUNDLE_FILE_TOOL_PLANNING_PATH,
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_IMAGE_PROCESSOR_PATH,
  WORKER_BUNDLE_SQLITE_STORE_PATH,
} from "../shared/worker-bundle-hash.js";
import loadHighlightJsRuntime from "./worker-deploy-highlight-runtime.cjs";
import { setWorkerDeployHighlightJsLoader } from "./worker-deploy-runtime-registry.js";

registerSealedRuntimeProcessEntrypoint(
  "fileToolPlanning",
  new URL(`./${WORKER_BUNDLE_FILE_TOOL_PLANNING_PATH}`, import.meta.url),
);
registerSealedRuntimeProcessEntrypoint(
  "githubExec",
  new URL(`./${WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH}`, import.meta.url),
);
registerSealedRuntimeProcessEntrypoint(
  "imageProcessor",
  new URL(`./${WORKER_BUNDLE_IMAGE_PROCESSOR_PATH}`, import.meta.url),
);
registerSealedRuntimeProcessEntrypoint(
  "serviceChildRelay",
  new URL("./service-child-relay.mjs", import.meta.url),
);
for (const name of ["sqliteStore", "sharedStateStore"] as const) {
  registerSealedRuntimeProcessEntrypoint(
    name,
    new URL(`./${WORKER_BUNDLE_SQLITE_STORE_PATH}`, import.meta.url),
  );
}
setWorkerDeployHighlightJsLoader(loadHighlightJsRuntime);
