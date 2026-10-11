import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  operatorApprovalOperations,
  type OperatorApprovalCommitReceipt,
} from "./operator-approval-store.operations.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

const operations: {
  [Key in keyof OperatorApprovalWorkerOperations]: (
    input: OperatorApprovalWorkerOperations[Key]["input"],
    context: Parameters<(typeof operatorApprovalOperations)[Key]>[1],
  ) => OperatorApprovalWorkerOperations[Key]["output"];
} = operatorApprovalOperations;

/** @deprecated Use api.runtime.gateway.request approval methods; removed in the next Plugin SDK major. */
export function executeNativeOperatorApproval<Key extends keyof OperatorApprovalWorkerOperations>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
  onCommitted: (receipt: OperatorApprovalCommitReceipt) => void,
): OperatorApprovalWorkerOperations[Key]["output"] {
  context.admission.assertCurrent();
  warnPluginSdkDeprecation({
    family: "native-approval-callback",
    method: "GatewayRequestHandlerOptions.sessionMutationCommitGuard (approval persistence)",
    replacement: "api.runtime.gateway.request approval methods with host-bound authority",
  });
  return runWithSqliteWorkerStateContext(context, () => {
    const options = { env: context.environment, path: context.admission.databasePath };
    return operations[type](input, {
      open: () => openOpenClawStateDatabase(options),
      stateOptions: () => options,
      native: { assertCurrent, onCommitted },
    });
  });
}
