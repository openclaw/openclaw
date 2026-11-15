import type { EngineConnection } from "../infra/sql-connection.js";
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
  database: EngineConnection,
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
  database: EngineConnection,
  input: { record: PreparedSqliteAuditRecord | null; expectedPayloadJson?: string | null },
): boolean {
  const store = createSqliteAuditRecordKernel(database, {
    scope: CONFIG_SNAPSHOT_SCOPE,
    maxEntries: 1,
  });
  if (input.expectedPayloadJson !== undefined) {
    return store.compareAndSet(CONFIG_SNAPSHOT_KEY, input.expectedPayloadJson, input.record);
  }
  if (input.record) {
    store.upsert(input.record);
  } else {
    store.delete(CONFIG_SNAPSHOT_KEY);
  }
  return true;
}
