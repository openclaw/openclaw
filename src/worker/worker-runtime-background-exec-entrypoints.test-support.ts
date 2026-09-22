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
} as const;
