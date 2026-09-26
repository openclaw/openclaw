import type { DatabaseSync } from "node:sqlite";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { readConfigSnapshotAuditRecordInDatabase } from "../config/config-journal-snapshot.kernel.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";

export function readStateDiagnosticCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "config.snapshot.read" | "audit.run.inspect" }
  >,
): OpenClawStateReadReply {
  const admitted = { ok: true, sourceAdmitted: true } as const;
  if (command.type === "config.snapshot.read") {
    return {
      ...admitted,
      type: command.type,
      snapshot: readConfigSnapshotAuditRecordInDatabase(db),
    };
  }
  try {
    return {
      ...admitted,
      type: command.type,
      result: {
        status: "inspected",
        inspection: runSqliteDeferredTransactionSync(db, () =>
          inspectExecutionIdentityRunInDatabase(db, command.input, {
            executionIdentityContexts: tableExists(db, "execution_identity_contexts"),
            auditEvents: tableExists(db, "audit_events"),
            cronRunReceipts: tableExists(db, "cron_run_receipts"),
            executionOwnerLifecycleBindings: tableExists(db, "execution_owner_lifecycle_bindings"),
          }),
        ),
      },
    };
  } catch (error) {
    if (!(error instanceof ExecutionDecisionCursorError)) {
      throw error;
    }
    return {
      ...admitted,
      type: command.type,
      result: { status: "invalid-cursor", message: error.message },
    };
  }
}
