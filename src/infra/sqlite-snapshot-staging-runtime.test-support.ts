const currentModuleUrl = import.meta.url;

export const sqliteSnapshotStagingEntrypoints = {
  source: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-snapshot-source",
    distWorkerPath: "infra/sqlite-snapshot-source.js",
  },
  owner: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-snapshot-staging-owner",
    distWorkerPath: "infra/sqlite-snapshot-staging-owner.js",
  },
  cleanup: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-readonly-location-cleanup",
    distWorkerPath: "infra/sqlite-readonly-location-cleanup.js",
  },
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
