export const toolingNativeRuntimeEntrypoints = {
  logger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../src/logging/logger",
    distWorkerPath: "logging/logger.js",
  },
  subsystemLogger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../src/logging/subsystem",
    distWorkerPath: "logging/subsystem.js",
  },
} as const;
