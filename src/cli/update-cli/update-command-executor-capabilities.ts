import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { ChildOperation, ChildPurpose } from "./update-command-executor-children.js";
import {
  originalCancellations,
  admittedAuthorities,
  admittedRunIds,
  retainedOwners,
  preflightReleases,
  slotReservations,
  childOwners,
  type ManagedUpdateLeaseAuthority,
} from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Revoke effects now; the owning invocation retains physical custody until it
 * and every admitted descendant join. Never returns a settlement capability. */
export function requestUpdateCommandExecutorCancellation(
  fence: UpdateRecoveryFence,
  runId: string,
  cause: Error,
): void {
  const cancel = originalCancellations.get(fence);
  if (!cancel) {
    throw new UpdateCommandRecoveryPendingError(
      "Cancellation requires its direct original executor.",
    );
  }
  cancel(runId, cause);
}

export function captureUpdateCommandExecutorAuthority(
  fence: UpdateRecoveryFence,
  runId?: string,
): ManagedUpdateLeaseAuthority {
  fence.assertCurrent();
  const admitted = admittedAuthorities.get(fence);
  if (!admitted || (runId !== undefined && admittedRunIds.get(fence) !== runId)) {
    throw new UpdateCommandRecoveryPendingError("Package recovery requires its admitted executor.");
  }
  return admitted.authority;
}

/** Requester checks also run while a bound child suspends its parent's mutation fence. */
export function assertUpdateRequesterContinuationOwner(
  fence: UpdateRecoveryFence,
  runId: string,
): void {
  const admitted = admittedAuthorities.get(fence);
  if (!admitted?.managedHandoff || admittedRunIds.get(fence) !== runId) {
    throw new UpdateCommandRecoveryPendingError(
      "Requester continuation requires its admitted Gateway update owner.",
    );
  }
  admitted.assertCurrent();
}

/** Compatibility requirement from a live admission, never a serialized claim. */
export function requiresRetainedUpdateCommandOwner(fence: UpdateRecoveryFence): boolean {
  captureUpdateCommandExecutorAuthority(fence);
  return retainedOwners.has(fence);
}

export function assertRetainedUpdateCommandRoot(fence: UpdateRecoveryFence, root: string): void {
  captureUpdateCommandExecutorAuthority(fence);
  if (retainedOwners.get(fence) !== resolveUpdateInstallRoot(root)) {
    throw new UpdateCommandRecoveryPendingError(
      "Service recovery requires its retained executor root.",
    );
  }
}

// Only a direct preflight owner can release before a supervised handoff. Neither
// a saved fence nor a borrowed helper lease grants this one-way transition.
export function releaseUpdateCommandPreflightForHandoff(fence: UpdateRecoveryFence): void {
  const release = preflightReleases.get(fence);
  if (!release) {
    throw new UpdateCommandRecoveryPendingError("Update preflight handoff is not current.");
  }
  release();
}

/** Reserve a prospective package slot without replacing the original domain. */
export function reserveUpdateCommandExecutorSlot(fence: UpdateRecoveryFence, root: string): void {
  const reserve = slotReservations.get(fence);
  if (!reserve) {
    throw new UpdateCommandRecoveryPendingError("Slot reservation requires its live executor.");
  }
  reserve(root);
}

export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  root: string,
  operation: ChildOperation<T>,
  purpose?: ChildPurpose,
): Promise<T> {
  const owner = childOwners.get(fence);
  if (!owner) {
    throw new UpdateCommandRecoveryPendingError("Child continuation requires its live executor.");
  }
  return await owner(root, operation, purpose);
}

export {
  captureUpdateCommandExecutorCurrentStores,
  captureUpdateCommandRecoveryGenerationAuthority,
  publishUpdateCommandPackageGeneration,
  publishUpdateCommandRecoveryGeneration,
} from "./update-command-executor-generation.js";
