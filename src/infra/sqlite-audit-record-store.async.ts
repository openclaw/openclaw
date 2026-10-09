import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "../state/openclaw-state-read.types.js";
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
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

export function createSqliteAuditRecordReader<T>(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    scope: string;
    assertCurrent?: () => void;
  },
) {
  const context = captureOpenClawStateReadWorkerContext(options);
  const source = { path: context.admission.databasePath, env: context.environment };
  const scope = options.scope;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  const read = async (command: OpenClawStateReadCommand) => {
    assertCurrent();
    const result = await executeExistingOpenClawStateRead(source, command, { context });
    assertCurrent();
    if (result && !result.ok) {
      throw new Error(result.message);
    }
    return result;
  };
  return {
    assertCurrent,
    async configAuditFacts(lastSeenAuditSequence: number) {
      const result = await read({
        type: "diagnostic.configAuditFacts",
        input: { scope, lastSeenAuditSequence },
      });
      if (!result) {
        return { auditSequence: 0, recentExternalEdit: false };
      }
      if (result.type !== "diagnostic.configAuditFacts") {
        throw new Error("Unexpected config audit facts result");
      }
      const { auditSequence, recentExternalEdit } = result;
      return { auditSequence, recentExternalEdit };
    },
    async latest(params: {
      limit: number;
      beforeSequence?: number;
    }): Promise<SequencedSqliteAuditRecordEntry<T>[]> {
      assertCurrent();
      const limit = Math.max(0, Math.floor(params.limit));
      if (limit === 0) {
        return [];
      }
      const result = await read({
        type: "diagnostic.latest",
        input: { scope, limit, beforeSequence: params.beforeSequence },
      });
      if (!result) {
        return [];
      }
      if (result.type !== "diagnostic.latest") {
        throw new Error("Unexpected audit record read result");
      }
      // SAFETY: This scope retains the native store's generic JSON payload contract.
      return result.entries as SequencedSqliteAuditRecordEntry<T>[];
    },
  };
}

/** Capture one physical audit store before preparation or worker admission yields. */
export function createSqliteAuditRecordWriter<T>(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    scope: string;
    maxEntries: number;
    assertCurrent?: () => void;
  },
) {
  const context = captureOpenClawStateWorkerContext(options);
  const scope = {
    scope: options.scope,
    maxEntries: Math.max(1, Math.floor(options.maxEntries)),
  };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  const admission = {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  };
  return {
    assertCurrent,
    async register(key: string, value: T, createdAt = Date.now()): Promise<void> {
      const input = {
        ...scope,
        record: prepareSqliteAuditRecord(scope.scope, { key, value, createdAt }),
      };
      await runOpenClawStateWorkerOperation(
        context,
        (store) => store.execute({ type: "diagnostic.register", input }),
        admission,
      );
    },
    compareAndSet: async (
      key: string,
      expectedValue: T | null,
      value: T | null,
      createdAt = Date.now(),
    ): Promise<boolean> => {
      const input = {
        ...scope,
        key,
        expectedPayloadJson: expectedValue === null ? null : JSON.stringify(expectedValue),
        record:
          value === null ? null : prepareSqliteAuditRecord(scope.scope, { key, value, createdAt }),
      };
      return await runOpenClawStateWorkerOperation(
        context,
        (store) => store.execute({ type: "diagnostic.compareAndSet", input }),
        admission,
      );
    },
  };
}

export async function registerSqliteAuditRecordAsync<T>(
  options: Parameters<typeof createSqliteAuditRecordWriter<T>>[0],
  record: SqliteAuditRecordEntry<T>,
): Promise<void> {
  await createSqliteAuditRecordWriter<T>(options).register(
    record.key,
    record.value,
    record.createdAt,
  );
}
