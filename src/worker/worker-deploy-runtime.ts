import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoint } from "../infra/runtime-process-url.js";
import loadHighlightJsRuntime from "./worker-deploy-highlight-runtime.cjs";
import { setWorkerDeployHighlightJsLoader } from "./worker-deploy-runtime-registry.js";

registerSealedRuntimeProcessEntrypoint(
  "githubExec",
  new URL("./github-exec-launcher.mjs", import.meta.url),
);
setWorkerDeployHighlightJsLoader(loadHighlightJsRuntime);
