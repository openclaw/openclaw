import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import * as store from "./operator-approval-store.kernel.js";
import * as transitions from "./operator-approval-store.transitions.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

type Operation = keyof OperatorApprovalWorkerOperations;
const operations: {
  [Key in Operation]: (
    input: OperatorApprovalWorkerOperations[Key]["input"] & {
      databaseOptions?: OpenClawStateDatabaseOptions;
    },
  ) => OperatorApprovalWorkerOperations[Key]["output"];
} = {
  "operatorApprovals.insert": store.insertOperatorApprovalInDatabase,
  "operatorApprovals.get": store.getOperatorApprovalDetailedInDatabase,
  "operatorApprovals.pending": store.listPendingOperatorApprovalsInDatabase,
  "operatorApprovals.resolve": transitions.resolveOperatorApprovalInDatabase,
  "operatorApprovals.deny": transitions.forceDenyOperatorApprovalInDatabase,
  "operatorApprovals.expire": transitions.expireDueOperatorApprovalsInDatabase,
  "operatorApprovals.consume": transitions.consumeOperatorApprovalAllowOnceInDatabase,
};

export function isOperatorApprovalOperation(type: string): type is Operation {
  return Object.hasOwn(operations, type);
}

export function executeOperatorApprovalOperation<Key extends Operation>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  databaseOptions: OpenClawStateDatabaseOptions,
): OperatorApprovalWorkerOperations[Key]["output"] {
  return operations[type]({ ...input, databaseOptions });
}
