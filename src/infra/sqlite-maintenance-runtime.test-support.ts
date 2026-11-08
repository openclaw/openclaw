import { createTestEntrypoint } from "./runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "infra");

export const sqliteMaintenanceEntrypoints = {
  updateLedger: entrypoint("update-run-ledger.process.test-support"),
  walReplacement: entrypoint("sqlite-wal.replacement.test-support"),
} as const;
