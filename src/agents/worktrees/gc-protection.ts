import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectManagedWorktreeCheckout } from "./checkout-inspection.js";
import { deferWorktreeGcRecord, type WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import type { createWorktreeLockPrefilter } from "./git-lock.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function autoRemovalProtectionReason(
  record: ManagedWorktreeRecord,
  isLocked: ReturnType<typeof createWorktreeLockPrefilter>,
  hasLiveLease: (id: string) => boolean,
  context: { env: NodeJS.ProcessEnv; getConfig: () => OpenClawConfig },
  policy: WorktreeCleanupOwnerPolicy = {},
): Promise<string | undefined> {
  if (record.gcProtection) {
    if (!policy.retryDeferred) {
      return record.gcProtection;
    }
    await deferWorktreeGcRecord(context.env, record, null);
  }
  if (
    record.ownerId !== undefined &&
    policy.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true
  ) {
    return "owner is active";
  }
  if (hasLiveLease(record.id)) {
    return "run lease is active";
  }
  if (await isLocked(record)) {
    return "worktree has a live or foreign lock";
  }
  const provisioned = await inspectManagedWorktreeCheckout(record, "provisioned", context);
  if (provisioned.retainedReason !== undefined) {
    return `provisioned checkout state is ${provisioned.retainedReason}`;
  }
  const nested = await inspectManagedWorktreeCheckout(record, "nested-repository", context);
  if (nested.retainedReason !== undefined) {
    const reason = "worktree contains a nested repository";
    await deferWorktreeGcRecord(context.env, record, reason);
    return reason;
  }
  return undefined;
}
