import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  createSqliteAuditRecordKernel,
  type PreparedSqliteAuditRecord,
} from "./sqlite-audit-record.kernel.js";

export const diagnosticOperations = {
  "diagnostic.compareAndSet": (
    input: {
      scope: string;
      maxEntries: number;
      key: string;
      expectedPayloadJson: string | null | undefined;
      record: PreparedSqliteAuditRecord | null;
    },
    { writeAdmitted },
  ) =>
    writeAdmitted(({ db }) =>
      createSqliteAuditRecordKernel(db, input).compareAndSet(
        input.key,
        input.expectedPayloadJson,
        input.record,
      ),
    ),
  "diagnostic.register": (
    input: { scope: string; maxEntries: number; record: PreparedSqliteAuditRecord },
    { writeAdmitted },
  ) => writeAdmitted(({ db }) => createSqliteAuditRecordKernel(db, input).register(input.record)),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
