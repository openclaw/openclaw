import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  prepareSqliteAuditRecord,
  type SqliteAuditRecordEntry,
} from "./sqlite-audit-record.kernel.js";

/** Serialize the audit record and capture its store before yielding to the shared actor. */
export async function registerSqliteAuditRecordAsync<T>(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    scope: string;
    maxEntries: number;
    assertCurrent?: () => void;
  },
  record: SqliteAuditRecordEntry<T>,
): Promise<void> {
  const input = {
    scope: options.scope,
    maxEntries: Math.max(1, Math.floor(options.maxEntries)),
    record: prepareSqliteAuditRecord(options.scope, record),
  };
  const context = captureOpenClawStateWorkerContext(options);
  await runOpenClawStateWorkerOperation(
    context,
    (store) => store.execute({ type: "diagnostic.register", input }),
    { assertCurrent: options.assertCurrent },
  );
}
