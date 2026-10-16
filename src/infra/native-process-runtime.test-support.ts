// Native process probes start their deadlines after the invocation owner prepares these modules.
export const nativeProcessTestEntrypoints = {
  updatePostgresState: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-candidate-state.postgres",
    distWorkerPath: "infra/update-candidate-state.postgres.js",
  },
  tailscale: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "tailscale",
    distWorkerPath: "infra/tailscale.js",
  },
  diagnosticsTimeline: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "diagnostics-timeline",
    distWorkerPath: "infra/diagnostics-timeline.js",
  },
  fsSafeCore: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "fs-safe",
    distWorkerPath: "infra/fs-safe.js",
  },
  fsSafeEnv: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "fs-safe-env",
    distWorkerPath: "infra/fs-safe-env.js",
  },
  memoryFsUtils: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/memory-host-sdk/src/host/fs-utils",
    distWorkerPath: "test-support/memory-fs-utils.js",
  },
} as const;
