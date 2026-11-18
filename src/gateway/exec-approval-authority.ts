import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import { isOperatorApprovalStoreRefusal } from "./operator-approval-store.js";
import type { OperatorApprovalStoreGuard } from "./operator-approval-store.types.js";

export class ApprovalMutationRefusedError extends Error {}

export function isExecApprovalMutationRefused(error: unknown): boolean {
  return (
    collectNestedErrorCandidates(error).some(
      (cause) => cause instanceof ApprovalMutationRefusedError,
    ) || isOperatorApprovalStoreRefusal(error)
  );
}

/** A refused caller is not storage corruption and must not settle its pending waiter. */
export function createExecApprovalMutationGuard(
  assertActive: () => void,
  assertBinding: () => void,
  caller: { guard?: OperatorApprovalStoreGuard; assertCurrent?: () => void },
): OperatorApprovalStoreGuard {
  return {
    family: caller.guard?.family ?? "worker",
    assertCurrent: () => {
      assertActive();
      try {
        caller.guard?.assertCurrent();
        caller.assertCurrent?.();
        assertBinding();
      } catch (error) {
        throw new ApprovalMutationRefusedError("approval resolver authority is no longer active", {
          cause: error,
        });
      }
    },
  };
}

export function isExecApprovalRuntimeActive<TPayload>(
  options: Pick<ExecApprovalManagerOptions<TPayload>, "validateAgentRuntimeDelegatedAuthority">,
  record: ExecApprovalRecord<TPayload>,
): boolean {
  const delegated = record.agentRuntimeDelegatedAuthority;
  if (
    (delegated && options.validateAgentRuntimeDelegatedAuthority?.(delegated) !== true) ||
    record.approvalSignals?.some((signal) => signal.aborted)
  ) {
    return false;
  }
  try {
    return record.approvalAuthority?.() !== false;
  } catch {
    return false;
  }
}
