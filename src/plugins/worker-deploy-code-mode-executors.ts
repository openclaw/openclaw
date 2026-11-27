import type { CodeModeExecutor } from "../agents/code-mode-executor-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

// Bundled Code Mode executor plugin IDs composed into portable worker bundles.
export const WORKER_DEPLOY_BUNDLED_CODE_MODE_EXECUTOR_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "code-mode-quickjs",
]);

export type WorkerDeployCodeModeExecutorOwner = {
  manifest: Pick<
    PluginManifestRecord,
    "id" | "origin" | "contracts" | "enabledByDefault" | "enabledByDefaultOnPlatforms"
  >;
  executor: CodeModeExecutor;
};

// Sealed portable worker builds compose bundled Code Mode executors here so
// isolated workers resolve selected executors without host plugin discovery.
export const workerDeployCodeModeExecutors: readonly WorkerDeployCodeModeExecutorOwner[] = [];
