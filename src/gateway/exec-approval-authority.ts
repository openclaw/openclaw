import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
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
