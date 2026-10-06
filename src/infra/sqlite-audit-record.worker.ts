import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  createSqliteAuditRecordKernel,
  type PreparedSqliteAuditRecord,
} from "./sqlite-audit-record.kernel.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

export const diagnosticOperations = {
  "diagnostic.compareAndSet": (
    input: {
      scope: string;
      maxEntries: number;
      key: string;
      expectedPayloadJson: string | null | undefined;
      record: PreparedSqliteAuditRecord | null;
    },
    { open, stateOptions },
  ) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const applied = createSqliteAuditRecordKernel(db, input).compareAndSet(
          input.key,
          input.expectedPayloadJson,
          input.record,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return applied;
      },
      { database, ...stateOptions() },
    );
  },
  "diagnostic.register": (
    input: { scope: string; maxEntries: number; record: PreparedSqliteAuditRecord },
    { open, stateOptions },
  ) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        createSqliteAuditRecordKernel(db, input).register(input.record);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      },
      { database, ...stateOptions() },
    );
  },
} satisfies WorkerOperationHandlers;
