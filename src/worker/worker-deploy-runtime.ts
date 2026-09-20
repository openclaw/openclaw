import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoint } from "../infra/runtime-process-url.js";
import {
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_IMAGE_PROCESSOR_PATH,
} from "../shared/worker-bundle-hash.js";
import loadHighlightJsRuntime from "./worker-deploy-highlight-runtime.cjs";
import { setWorkerDeployHighlightJsLoader } from "./worker-deploy-runtime-registry.js";

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
setWorkerDeployHighlightJsLoader(loadHighlightJsRuntime);
