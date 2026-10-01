import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { executeOperatorApprovalOperation } from "./operator-approval-store.operations.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

// Retain the v2026.9.4 opaque SDK commit guard beside the same native transaction.
// Remove this branch only when that SDK contract can require a worker-safe guard.
export function executeNativeOperatorApproval<Key extends keyof OperatorApprovalWorkerOperations>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
  onCommitted?: (receipt: { type: "operatorApprovals.resolve"; resolutionKey: string }) => void,
): OperatorApprovalWorkerOperations[Key]["output"] {
  context.admission.assertCurrent();
  return runWithSqliteWorkerStateContext(context, () => {
    const options = { env: context.environment, path: context.admission.databasePath };
    return runOpenClawStateWriteTransaction((database) => {
      assertCurrent();
      const result = executeOperatorApprovalOperation(type, input, { ...options, database });
      if (
        onCommitted &&
        type === "operatorApprovals.resolve" &&
        "outcome" in result &&
        result.outcome === "resolved"
      ) {
        const receipt = {
          type: "operatorApprovals.resolve" as const,
          resolutionKey: getOperatorApprovalResolutionKey(result.record),
        };
        if (!deferSqlitePostCommitPublication(database.db, () => onCommitted(receipt))) {
          throw new Error("Operator approval commit receipt requires a transaction owner");
        }
      }
      assertCurrent();
      return result;
    }, options);
  });
}
