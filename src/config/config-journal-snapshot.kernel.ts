import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteAuditRecordKernel,
  type PreparedSqliteAuditRecord,
} from "../infra/sqlite-audit-record.kernel.js";

export const CONFIG_SNAPSHOT_SCOPE = "config-snapshot";
export const CONFIG_SNAPSHOT_KEY = "latest";

export type ConfigSnapshotAuditRecord = {
  configPath: string;
  rawHash: string;
  fingerprintedAuthoredConfig: unknown;
};

export function readConfigSnapshotAuditRecordInDatabase(
  database: DatabaseSync,
): ConfigSnapshotAuditRecord | null {
  return (
    createSqliteAuditRecordKernel<ConfigSnapshotAuditRecord>(database, {
      scope: CONFIG_SNAPSHOT_SCOPE,
      maxEntries: 1,
    })
      .entries()
      .find((entry) => entry.key === CONFIG_SNAPSHOT_KEY)?.value ?? null
  );
}

export function upsertConfigSnapshotAuditRecordInDatabase(
  database: DatabaseSync,
  input: { record: PreparedSqliteAuditRecord; expectedPayloadJson?: string | null },
): boolean {
  const store = createSqliteAuditRecordKernel(database, {
    scope: CONFIG_SNAPSHOT_SCOPE,
    maxEntries: 1,
  });
  if (input.expectedPayloadJson !== undefined) {
    return store.compareAndSet(CONFIG_SNAPSHOT_KEY, input.expectedPayloadJson, input.record);
  }
  store.upsert(input.record);
  return true;
}
