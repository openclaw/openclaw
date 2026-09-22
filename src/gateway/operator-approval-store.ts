// Runtime approval operations retain the shared-state owner through worker settlement.
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { decodeOperatorApprovalHistoryCursor } from "./operator-approval-store.rows.js";
import type {
  ListTerminalOperatorApprovalsInput,
  ListTerminalOperatorApprovalsResult,
} from "./operator-approval-store.types.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

export type {
  OperatorApprovalKind,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
  OperatorApprovalResolver,
  OperatorApprovalRecord,
  ResolveOperatorApprovalResult,
  ForceDenyOperatorApprovalResult,
} from "./operator-approval-store.types.js";
export {
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OperatorApprovalHistoryCursorError,
} from "./operator-approval-store.rows.js";
export {
  // Connection-bound receipt readers execute inside the audit read worker.
  hasOperatorApprovalReceiptsForRunInDatabase,
  summarizeOperatorApprovalReceiptsForRunInDatabase,
  pageOperatorApprovalReceiptsForRunInDatabase,
} from "./operator-approval-store.receipts.js";
export {
  // Gateway boot admission closes orphaned rows and prunes before serving requests.
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.transitions.js";

type Operation = keyof OperatorApprovalWorkerOperations;
type Options = { databaseOptions?: OpenClawStateDatabaseOptions; assertCurrent?: () => void };
type Input<Key extends Operation> = OperatorApprovalWorkerOperations[Key]["input"] & Options;

function execute<Key extends Operation>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  { databaseOptions, assertCurrent }: Options,
): Promise<OperatorApprovalWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  const captured = structuredClone(input);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type, input: captured }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Operator approval mutation requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      }),
    },
  );
}

export function insertOperatorApproval(params: Input<"operatorApprovals.insert">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.insert", input, { databaseOptions, assertCurrent });
}
export function getOperatorApprovalDetailed(params: Input<"operatorApprovals.get">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.get", input, { databaseOptions, assertCurrent });
}
export function listPendingOperatorApprovals(params: Input<"operatorApprovals.pending"> = {}) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.pending", input, { databaseOptions, assertCurrent });
}
export function resolveOperatorApproval(params: Input<"operatorApprovals.resolve">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.resolve", input, { databaseOptions, assertCurrent });
}
export function forceDenyOperatorApproval(params: Input<"operatorApprovals.deny">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.deny", input, { databaseOptions, assertCurrent });
}
export function expireDueOperatorApprovals(params: Input<"operatorApprovals.expire">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.expire", input, { databaseOptions, assertCurrent });
}
export function consumeOperatorApprovalAllowOnce(params: Input<"operatorApprovals.consume">) {
  const { databaseOptions, assertCurrent, ...input } = params;
  return execute("operatorApprovals.consume", input, { databaseOptions, assertCurrent });
}

export async function listTerminalOperatorApprovals(
  params: ListTerminalOperatorApprovalsInput & Options = {},
): Promise<ListTerminalOperatorApprovalsResult> {
  const { databaseOptions, assertCurrent, ...input } = params;
  if (input.cursor !== undefined) {
    decodeOperatorApprovalHistoryCursor(input.cursor);
  }
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  // Preserve the original creating/writable admission before the fixed read.
  await runOpenClawStateWorkerOperation(context, async () => {}, { assertCurrent });
  const result = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    { type: "operatorApprovals.history", input },
  );
  context.admission.assertCurrent();
  assertCurrent?.();
  if (result?.ok && result.type === "operatorApprovals.history") {
    return result.history;
  }
  throw new Error("Operator approval history database became unavailable");
}
