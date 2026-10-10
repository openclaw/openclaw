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
