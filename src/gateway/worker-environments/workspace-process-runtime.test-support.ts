export const workspaceProcessTestEntrypoints = {
  manifestWorker: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "workspace-manifest-worker",
    distWorkerPath: "gateway/worker-environments/workspace-manifest-worker.js",
  },
  hashMemo: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "workspace-hash-memo",
    distWorkerPath: "gateway/worker-environments/workspace-hash-memo.js",
  },
  inventoryLimits: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "workspace-inventory-limits",
    distWorkerPath: "gateway/worker-environments/workspace-inventory-limits.js",
  },
  resultStaging: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "workspace-result-staging",
    distWorkerPath: "gateway/worker-environments/workspace-result-staging.js",
  },
  nodeWorkspace: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../node-host/node-worker-workspace",
    distWorkerPath: "node-host/node-worker-workspace.js",
  },
} as const;
