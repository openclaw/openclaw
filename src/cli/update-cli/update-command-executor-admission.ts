import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { ChildOperation, ChildPurpose } from "./update-command-executor-children.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;
export const admittedAuthorities = new WeakMap<
  UpdateRecoveryFence,
  {
    authority: ManagedUpdateLeaseAuthority;
    assertCurrent: () => void;
    managedHandoff: boolean;
  }
>();
export const admittedRunIds = new WeakMap<UpdateRecoveryFence, string>();
export const retainedOwners = new WeakMap<UpdateRecoveryFence, string>();

export function clearUpdateCommandExecutorAdmission(fence: UpdateRecoveryFence): void {
  admittedAuthorities.delete(fence);
  admittedRunIds.delete(fence);
  retainedOwners.delete(fence);
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
export const preflightReleases = new WeakMap<UpdateRecoveryFence, () => void>();
export function releaseUpdateCommandPreflightForHandoff(fence: UpdateRecoveryFence): void {
  const release = preflightReleases.get(fence);
  if (!release) {
    throw new UpdateCommandRecoveryPendingError("Update preflight handoff is not current.");
  }
  release();
}

export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

export const childOwners = new WeakMap<
  UpdateRecoveryFence,
  <T>(root: string, operation: ChildOperation<T>, purpose?: ChildPurpose) => Promise<T>
>();

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
