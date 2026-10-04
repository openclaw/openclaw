import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { inspectManagedWorktreeCheckout } from "./checkout-inspection.js";
import { deferWorktreeGcRecord, type WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import type { createWorktreeGcPrefilter } from "./git-lock.js";
import { worktreeGcRevision } from "./registry-read.kernel.js";
import type { ManagedWorktreeRecord } from "./types.js";

export type WorktreeCleanupDeferrals = Map<
  string,
  { revision: string; fingerprint: string | null }
>;

export async function autoRemovalProtectionReason(
  record: ManagedWorktreeRecord,
  prefilter: ReturnType<typeof createWorktreeGcPrefilter>,
  hasLiveLease: (id: string) => boolean,
  context: {
    env: NodeJS.ProcessEnv;
    getConfig: () => OpenClawConfig;
    signal?: AbortSignal;
    beforeRun?: () => void;
    deferrals: WorktreeCleanupDeferrals;
  },
  policy: WorktreeCleanupOwnerPolicy = {},
): Promise<string | undefined> {
  if (
    record.ownerId !== undefined &&
    policy.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true
  ) {
    return "owner is active";
  }
  if (hasLiveLease(record.id)) {
    return "run lease is active";
  }
  const revision = worktreeGcRevision(record);
  const previous = context.deferrals.get(record.id);
  const fingerprint =
    record.gcProtection || !previous
      ? await runGitWorkerOperation(
          { type: "worktree.cleanup-fingerprint", input: { checkoutPath: record.path } },
          { signal: context.signal, assertCurrent: context.beforeRun },
        )
      : previous.fingerprint;
  context.deferrals.set(record.id, { revision, fingerprint });
  if (record.gcProtection) {
    if (
      !policy.retryDeferred &&
      (!previous || (previous.revision === revision && previous.fingerprint === fingerprint))
    ) {
      return record.gcProtection;
    }
    await deferWorktreeGcRecord(context.env, record, null, context.beforeRun);
  }
  const protection = await prefilter(record);
  if (protection !== undefined) {
    if (protection === "branch-moved") {
      await deferWorktreeGcRecord(context.env, record, protection, context.beforeRun);
    }
    return protection;
  }
  const provisioned = await inspectManagedWorktreeCheckout(record, "provisioned", context);
  if (provisioned.retainedReason !== undefined) {
    return `provisioned checkout state is ${provisioned.retainedReason}`;
  }
  const nested = await inspectManagedWorktreeCheckout(record, "nested-repository", context);
  if (nested.retainedReason !== undefined) {
    const reason = "worktree contains a nested repository";
    await deferWorktreeGcRecord(context.env, record, reason, context.beforeRun);
    return reason;
  }
  return undefined;
}
