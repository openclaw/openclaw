import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import * as store from "./operator-approval-store.kernel.js";
import * as transitions from "./operator-approval-store.transitions.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

type Operation = keyof OperatorApprovalWorkerOperations;
const operations: {
  [Key in Operation]: (
    input: OperatorApprovalWorkerOperations[Key]["input"],
    databaseOptions: OpenClawStateDatabaseOptions,
  ) => OperatorApprovalWorkerOperations[Key]["output"];
} = {
  "operatorApprovals.insert": (input, databaseOptions) =>
    store.insertOperatorApprovalInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.get": (input, databaseOptions) =>
    store.getOperatorApprovalDetailedInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.pending": (input, databaseOptions) =>
    store.listPendingOperatorApprovalsInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.resolve": (input, databaseOptions) =>
    transitions.resolveOperatorApprovalInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.deny": (input, databaseOptions) =>
    transitions.forceDenyOperatorApprovalInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.expire": (input, databaseOptions) =>
    transitions.expireDueOperatorApprovalsInDatabase({ ...input, databaseOptions }),
  "operatorApprovals.consume": (input, databaseOptions) =>
    transitions.consumeOperatorApprovalAllowOnceInDatabase({ ...input, databaseOptions }),
};

export function executeOperatorApprovalOperation<Key extends Operation>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  databaseOptions: OpenClawStateDatabaseOptions,
): OperatorApprovalWorkerOperations[Key]["output"] {
  return operations[type](input, databaseOptions);
}
