import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectManagedWorktreeCheckout } from "./checkout-inspection.js";
import type { createWorktreeLockPrefilter } from "./git-lock.js";
import type { ManagedWorktreeRecord, ManagedWorktreeOwnerKind } from "./types.js";

export async function autoRemovalProtectionReason(
  record: ManagedWorktreeRecord,
  isLocked: ReturnType<typeof createWorktreeLockPrefilter>,
  hasLiveLease: (id: string) => boolean,
  context: { env: NodeJS.ProcessEnv; getConfig: () => OpenClawConfig },
  shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean,
): Promise<string | undefined> {
  if (
    record.ownerId !== undefined &&
    shouldProtectOwner?.(record.ownerKind, record.ownerId) === true
  ) {
    return "owner is active";
  }
  if (hasLiveLease(record.id)) {
    return "run lease is active";
  }
  const provisioned = await inspectManagedWorktreeCheckout(record, "provisioned", context);
  if (provisioned.retainedReason !== undefined) {
    return `provisioned checkout state is ${provisioned.retainedReason}`;
  }
  if (await isLocked(record)) {
    return "worktree has a live or foreign lock";
  }
  const nested = await inspectManagedWorktreeCheckout(record, "nested-repository", context);
  return nested.retainedReason === undefined ? undefined : "worktree contains a nested repository";
}
