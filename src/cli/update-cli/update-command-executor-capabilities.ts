import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { ChildOperation, ChildPurpose } from "./update-command-executor-children.js";
import {
  originalCancellations,
  admittedAuthorities,
  preflightReleases,
  slotReservations,
  childOwners,
  type ManagedUpdateLeaseAuthority,
} from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

function requireCapability<T>(capability: T | undefined, message: string): T {
  if (!capability) {
    throw new UpdateCommandRecoveryPendingError(message);
  }
  return capability;
}

export function requireUpdateCommandAcquisition(
  acquired: ReturnType<ReturnType<typeof createManagedHandoffLeaseStore>["acquire"]>,
  message: string,
) {
  if (acquired.kind !== "acquired") {
    throw new UpdateCommandRecoveryPendingError(message);
  }
  return acquired;
}

/** Revoke effects now; the owning invocation retains physical custody until it
 * and every admitted descendant join. Never returns a settlement capability. */
export function requestUpdateCommandExecutorCancellation(
  fence: UpdateRecoveryFence,
  runId: string,
  cause: Error,
): void {
  requireCapability(
    originalCancellations.get(fence),
    "Cancellation requires its direct original executor.",
  )(runId, cause);
}

export function captureUpdateCommandExecutorAuthority(
  fence: UpdateRecoveryFence,
  runId?: string,
): ManagedUpdateLeaseAuthority {
  fence.assertCurrent();
  const admitted = admittedAuthorities.get(fence);
  if (!admitted || (runId !== undefined && admitted.runId !== runId)) {
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
  if (!admitted?.managedHandoff || admitted.runId !== runId) {
    throw new UpdateCommandRecoveryPendingError(
      "Requester continuation requires its admitted Gateway update owner.",
    );
  }
  admitted.assertCurrent();
}

/** Compatibility requirement from a live admission, never a serialized claim. */
export function requiresRetainedUpdateCommandOwner(fence: UpdateRecoveryFence): boolean {
  captureUpdateCommandExecutorAuthority(fence);
  return admittedAuthorities.get(fence)?.retainedRoot !== undefined;
}

export function assertRetainedUpdateCommandRoot(fence: UpdateRecoveryFence, root: string): void {
  captureUpdateCommandExecutorAuthority(fence);
  if (admittedAuthorities.get(fence)?.retainedRoot !== resolveUpdateInstallRoot(root)) {
    throw new UpdateCommandRecoveryPendingError(
      "Service recovery requires its retained executor root.",
    );
  }
}

// Only a direct preflight owner can release before a supervised handoff. Neither
// a saved fence nor a borrowed helper lease grants this one-way transition.
export function releaseUpdateCommandPreflightForHandoff(fence: UpdateRecoveryFence): void {
  requireCapability(preflightReleases.get(fence), "Update preflight handoff is not current.")();
}

/** Reserve a prospective package slot without replacing the original domain. */
export function reserveUpdateCommandExecutorSlot(fence: UpdateRecoveryFence, root: string): void {
  requireCapability(
    slotReservations.get(fence),
    "Slot reservation requires its live executor.",
  )(root);
}

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  root: string,
  operation: ChildOperation<T>,
  purpose?: ChildPurpose,
): Promise<T> {
  return await requireCapability(
    childOwners.get(fence),
    "Child continuation requires its live executor.",
  )(root, operation, purpose);
}
