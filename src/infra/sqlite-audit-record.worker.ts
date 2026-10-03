import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  createSqliteAuditRecordKernel,
  type PreparedSqliteAuditRecord,
} from "./sqlite-audit-record.kernel.js";

export const diagnosticOperations = {
  "diagnostic.register": (
    input: { scope: string; maxEntries: number; record: PreparedSqliteAuditRecord },
    { open, stateOptions },
  ) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        createSqliteAuditRecordKernel(db, input).register(input.record);
      },
      { database, ...stateOptions() },
    );
  },
} satisfies WorkerOperationHandlers;
