import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import * as store from "./operator-approval-store.kernel.js";
import * as transitions from "./operator-approval-store.transitions.js";
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
    const execute = () => {
      switch (command.type) {
        case "operatorApprovals.insert":
          return store.insertOperatorApprovalInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.get":
          return store.getOperatorApprovalDetailedInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.pending":
          return store.listPendingOperatorApprovalsInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.resolve":
          return transitions.resolveOperatorApprovalInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.deny":
          return transitions.forceDenyOperatorApprovalInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.expire":
          return transitions.expireDueOperatorApprovalsInDatabase({
            ...command.input,
            databaseOptions: options,
          });
        case "operatorApprovals.consume":
          return transitions.consumeOperatorApprovalAllowOnceInDatabase({
            ...command.input,
            databaseOptions: options,
          });
      }
      return command satisfies never;
    };
    const result = execute();
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return result;
  }, databaseOptions);
}
