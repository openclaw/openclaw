const currentModuleUrl = import.meta.url;

export const sqliteSnapshotStagingEntrypoints = {
  snapshot: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-readonly-location",
    distWorkerPath: "infra/sqlite-readonly-location.js",
  },
  staging: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-snapshot-staging",
    distWorkerPath: "infra/sqlite-snapshot-staging.js",
  },
  logger: {
    currentModuleUrl,
    sourceWorkerName: "../logging/logger",
    distWorkerPath: "logging/logger.js",
  },
} as const;
