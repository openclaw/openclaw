import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { executeOperatorApprovalOperation } from "./operator-approval-store.operations.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

export function isOperatorApprovalCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<OperatorApprovalWorkerOperations> {
  switch (command.type) {
    case "operatorApprovals.insert":
    case "operatorApprovals.get":
    case "operatorApprovals.pending":
    case "operatorApprovals.resolve":
    case "operatorApprovals.deny":
    case "operatorApprovals.expire":
    case "operatorApprovals.consume":
      return true;
    default:
      return false;
  }
}

export function executeOperatorApprovalCommand(
  command: SqliteWorkerCommand<OperatorApprovalWorkerOperations>,
  databaseOptions: OpenClawStateDatabaseOptions,
): OperatorApprovalWorkerOperations[keyof OperatorApprovalWorkerOperations]["output"] {
  return runOpenClawStateWriteTransaction((database) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    const options = { ...databaseOptions, database };
    const result = executeOperatorApprovalOperation(command.type, command.input, options);
    if (
      command.type === "operatorApprovals.resolve" &&
      "outcome" in result &&
      result.outcome === "resolved"
    ) {
      deferSqliteWorkerCommitReceipt(database.db, {
        type: command.type,
        resolutionKey: getOperatorApprovalResolutionKey(result.record),
      });
    }
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return result;
  }, databaseOptions);
}
