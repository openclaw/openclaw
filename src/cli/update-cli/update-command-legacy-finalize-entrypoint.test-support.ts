export const legacyFinalizeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-command-legacy-finalize.test-support",
  distWorkerPath:
    "legacy-finalizer/src/cli/update-cli/update-command-legacy-finalize.test-support.js",
} as const;

// Replacement hooks need physical modules and complete namespaces in one graph.
export const updateServiceRuntimeEntrypoints = {
  command: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-command-service-command",
    distWorkerPath: "legacy-finalizer/src/cli/update-cli/update-command-service-command.js",
  },
} as const;

// Fence tests use the same prepared, hookable candidate graph as legacy finalization.
export const migratedFenceEntrypoints = {
  service: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../daemon/service",
    distWorkerPath: "legacy-finalizer/src/daemon/service.js",
  },
  worker: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../infra/update-migrated-finalize.worker",
    distWorkerPath: "legacy-finalizer/src/infra/update-migrated-finalize.worker.js",
  },
  verification: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-command-verification",
    distWorkerPath: "legacy-finalizer/src/cli/update-cli/update-command-verification.js",
  },
} as const;
