// Shared SQLite storage for bounded diagnostic audit records.
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
  type SqliteAuditRecordEntry,
} from "./sqlite-audit-record.kernel.js";

/** Opens one bounded audit-record scope in the shared state database. */
export function createSqliteAuditRecordStore<T>(
  options: OpenClawStateDatabaseOptions & { scope: string; maxEntries: number },
) {
  const scope = options.scope;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const kernel = (database: DatabaseSync) =>
    createSqliteAuditRecordKernel<T>(database, { scope, maxEntries });
  const prepare = (record: SqliteAuditRecordEntry<T>) => prepareSqliteAuditRecord(scope, record);
  return {
    register(key: string, value: T, createdAt = Date.now()): void {
      const record = prepare({ key, value, createdAt });
      runOpenClawStateWriteTransaction(({ db }) => kernel(db).register(record), options);
    },
    upsert(key: string, value: T, createdAt = Date.now()): void {
      const record = prepare({ key, value, createdAt });
      runOpenClawStateWriteTransaction(({ db }) => kernel(db).upsert(record), options);
    },
    registerLegacyMany(records: readonly SqliteAuditRecordEntry<T>[]): void {
      const prepared = records.map(prepare);
      if (prepared.length === 0) {
        return;
      }
      runOpenClawStateWriteTransaction(
        ({ db }) => kernel(db).registerLegacyMany(prepared),
        options,
      );
    },
    entries() {
      return kernel(openOpenClawStateDatabase(options).db).entries();
    },
    latest(params: { limit: number; beforeSequence?: number }) {
      const limit = Math.max(0, Math.floor(params.limit));
      if (limit === 0) {
        return [];
      }
      return kernel(openOpenClawStateDatabase(options).db).latest({ ...params, limit });
    },
  };
}
