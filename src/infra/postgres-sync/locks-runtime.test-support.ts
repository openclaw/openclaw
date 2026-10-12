export const postgresLockTestEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "locks-worker.test-support",
  distWorkerPath: "infra/postgres-sync/locks-worker.test-support.js",
} as const;
