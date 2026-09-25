export const diagnosticProfileEntrypoints = {
  cpu: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "diagnostic-cpu-profile",
    distWorkerPath: "logging/diagnostic-cpu-profile.js",
  },
  heap: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "diagnostic-heap-profile",
    distWorkerPath: "logging/diagnostic-heap-profile.js",
  },
  workload: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "diagnostic-heap-profile.test-helpers",
    distWorkerPath: "logging/diagnostic-heap-profile.test-helpers.js",
  },
} as const;
