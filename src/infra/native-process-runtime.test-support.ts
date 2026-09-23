// Native process probes start their deadlines after the invocation owner prepares these modules.
export const nativeProcessTestEntrypoints = {
  updateCandidateIo: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-candidate-io",
    distWorkerPath: "infra/update-candidate-io.js",
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
  fsSafeDefaults: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "fs-safe-defaults",
    distWorkerPath: "infra/fs-safe-defaults.js",
  },
  memoryFsUtils: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/memory-host-sdk/src/host/fs-utils",
    distWorkerPath: "test-support/memory-fs-utils.js",
  },
} as const;
