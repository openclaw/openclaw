// Prepare the parent and native workers before starting each fresh cache lifetime.
export const sqliteReadOnlyCompileCacheParentEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "sqlite-readonly-worker.compile-cache-parent.test-support",
  distWorkerPath: "infra/sqlite-readonly-worker.compile-cache-parent.test-support.js",
} as const;
