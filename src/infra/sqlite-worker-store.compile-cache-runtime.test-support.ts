// Prepare the parent and native workers before starting each fresh cache lifetime.
export const sqliteWorkerStoreCompileCacheParentEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "sqlite-worker-store.compile-cache-parent.test-support",
  distWorkerPath: "infra/sqlite-worker-store.compile-cache-parent.test-support.js",
} as const;
