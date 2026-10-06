// Gateway import hooks require the prepared graph's physical module boundaries.
export const spawnBrokerContextEntrypoints = {
  server: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../gateway/server",
    distWorkerPath: "legacy-finalizer/src/gateway/server.js",
  },
  exec: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../exec",
    distWorkerPath: "legacy-finalizer/src/process/exec.js",
  },
  context: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "context",
    distWorkerPath: "legacy-finalizer/src/process/spawn-broker/context.js",
  },
} as const;
