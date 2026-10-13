export const sqliteMaintenanceEntrypoints = {
  updateLedger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-run-ledger.process.test-support",
    distWorkerPath: "infra/update-run-ledger.process.test-support.js",
  },
  walReplacement: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-wal.replacement.test-support",
    distWorkerPath: "infra/sqlite-wal.replacement.test-support.js",
  },
} as const;
