import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoint } from "../infra/runtime-process-url.js";
import {
  WORKER_BUNDLE_FILE_TOOL_PLANNING_PATH,
  WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH,
  WORKER_BUNDLE_IMAGE_PROCESSOR_PATH,
  WORKER_BUNDLE_SQLITE_STORE_PATH,
} from "../shared/worker-bundle-hash.js";

for (const [name, file] of [
  ["codeModeNode", "code-mode-node.worker.mjs"],
  ["stateRead", "openclaw-state-read.worker.mjs"],
  ["workerNativeLifecycle", "worker-native-lifecycle.worker.mjs"],
  ["fileToolPlanning", WORKER_BUNDLE_FILE_TOOL_PLANNING_PATH],
  ["githubExec", WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH],
  ["imageProcessor", WORKER_BUNDLE_IMAGE_PROCESSOR_PATH],
  ["serviceChildRelay", "service-child-relay.mjs"],
  ["sqliteStore", WORKER_BUNDLE_SQLITE_STORE_PATH],
  ["sharedStateStore", WORKER_BUNDLE_SQLITE_STORE_PATH],
] as const) {
  registerSealedRuntimeProcessEntrypoint(name, new URL(`./${file}`, import.meta.url));
}
