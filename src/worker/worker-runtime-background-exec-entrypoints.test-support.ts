// Separate crash-test processes share one invocation's compiled runtime graph.
const currentModuleUrl = import.meta.url;

export const workerBackgroundExecEntrypoints = {
  worker: {
    currentModuleUrl,
    sourceWorkerName: "worker-process",
    distWorkerPath: "worker/worker-process.js",
  },
  supervisor: {
    currentModuleUrl,
    sourceWorkerName: "../node-host/node-worker-supervisor",
    distWorkerPath: "node-host/node-worker-supervisor.js",
  },
  turnStore: {
    currentModuleUrl,
    sourceWorkerName: "../node-host/node-worker-turn-store",
    distWorkerPath: "node-host/node-worker-turn-store.js",
  },
  launchStore: {
    currentModuleUrl,
    sourceWorkerName: "../node-host/node-worker-launch-store",
    distWorkerPath: "node-host/node-worker-launch-store.js",
  },
  journalWorker: {
    currentModuleUrl,
    sourceWorkerName: "../node-host/node-worker-journal-worker",
    distWorkerPath: "node-host/node-worker-journal-worker.js",
  },
  processIdentity: {
    currentModuleUrl,
    sourceWorkerName: "../node-host/node-worker-process-identity",
    distWorkerPath: "node-host/node-worker-process-identity.js",
  },
  providerModelMetadata: {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/provider-model-metadata",
    distWorkerPath: "plugin-sdk/provider-model-metadata.js",
  },
  stringCoerceRuntime: {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/string-coerce-runtime",
    distWorkerPath: "plugin-sdk/string-coerce-runtime.js",
  },
  moduleLoader: {
    currentModuleUrl,
    sourceWorkerName: "../plugins/plugin-module-loader-cache",
    distWorkerPath: "plugins/plugin-module-loader-cache.js",
  },
} as const;
