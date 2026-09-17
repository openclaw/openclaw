import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  OperatorApprovalHistoryCursorError,
  decodeOperatorApprovalHistoryCursor,
  requireApprovalId,
  type getOperatorApprovalDetailed as getOperatorApprovalDetailedInKernel,
  type listTerminalOperatorApprovals as listTerminalOperatorApprovalsInKernel,
} from "./operator-approval-store.js";

export async function getOperatorApprovalDetailedAsync(
  params: Parameters<typeof getOperatorApprovalDetailedInKernel>[0] & {
    assertCurrent?: () => void;
  },
): Promise<ReturnType<typeof getOperatorApprovalDetailedInKernel>> {
  const { databaseOptions, assertCurrent, ...input } = params;
  requireApprovalId(input.id);
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "operatorApproval.getDetailed", input }),
    {
      assertCurrent,
      createAdmission: () => {
        let phase: "transaction" | "commit" | "complete" = "transaction";
        return {
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== phase) {
              throw new Error("Operator approval lookup admission requested out of order");
            }
            context.admission.assertCurrent();
            assertCurrent?.();
            if (!grant()) {
              throw new Error("Operator approval lookup admission expired");
            }
            phase = phase === "transaction" ? "commit" : "complete";
          }),
        };
      },
    },
  );
}

export async function listTerminalOperatorApprovalsAsync(
  params: NonNullable<Parameters<typeof listTerminalOperatorApprovalsInKernel>[0]> = {},
): Promise<ReturnType<typeof listTerminalOperatorApprovalsInKernel>> {
  const { databaseOptions, ...input } = params;
  if (input.cursor !== undefined) {
    decodeOperatorApprovalHistoryCursor(input.cursor);
  }
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  const result = await runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({ type: "operatorApproval.history", input }),
  );
  if (!result.ok) {
    throw new OperatorApprovalHistoryCursorError();
  }
  return result.history;
}

export { OperatorApprovalHistoryCursorError } from "./operator-approval-store.js";
