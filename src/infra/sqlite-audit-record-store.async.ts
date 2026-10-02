import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  prepareSqliteAuditRecord,
  type SequencedSqliteAuditRecordEntry,
  type SqliteAuditRecordEntry,
} from "./sqlite-audit-record.kernel.js";

export function createSqliteAuditRecordReader<T>(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & { scope: string },
) {
  const context = captureOpenClawStateReadWorkerContext(options);
  const source = { path: context.admission.databasePath, env: context.environment };
  const scope = options.scope;
  return {
    async latest(params: {
      limit: number;
      beforeSequence?: number;
    }): Promise<SequencedSqliteAuditRecordEntry<T>[]> {
      const limit = Math.max(0, Math.floor(params.limit));
      if (limit === 0) {
        return [];
      }
      const result = await executeExistingOpenClawStateRead(
        source,
        {
          type: "diagnostic.latest",
          input: { scope, limit, beforeSequence: params.beforeSequence },
        },
        { context },
      );
      context.admission.assertCurrent();
      if (!result?.ok || result.type !== "diagnostic.latest") {
        return [];
      }
      // SAFETY: This scope retains the native store's generic JSON payload contract.
      return result.entries as SequencedSqliteAuditRecordEntry<T>[];
    },
  };
}

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
