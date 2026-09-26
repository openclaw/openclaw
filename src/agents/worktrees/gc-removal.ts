import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { hasMissingManagedWorktreeGitdir } from "./checkout-inspection.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { retireMissingRegistryWorktree } from "./registry-retirement.js";
import {
  assertWorktreeRemovalClaim,
  getRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import {
  isWorktreePermissionError,
  WorktreeBranchMovedError,
  WorktreeRemovalLockError,
} from "./removal-errors.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export type WorktreeCleanupOwnerPolicy = {
  shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  shouldRemoveOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
};

export function assertOwnerAllowsCleanup(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  params: WorktreeCleanupOwnerPolicy,
  retiredOwner = false,
) {
  if (getRegistryWorktree(env, record.id)?.lastActiveAt !== record.lastActiveAt) {
    throw new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
  }
  if (
    record.ownerId !== undefined &&
    (params.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true ||
      (retiredOwner && params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) !== true))
  ) {
    throw new WorktreeRemovalLockError("busy", "worktree owner became active during cleanup");
  }
}

export function createWorktreeGcErrorHandler(context: {
  env: NodeJS.ProcessEnv;
  now: number;
  progress: WorktreeGcProgress;
  policy: WorktreeCleanupOwnerPolicy;
}) {
  const { env, now, progress, policy } = context;
  return async (
    stage: "idle" | "limits",
    record: ManagedWorktreeRecord,
    initialError: unknown,
    retiredOwner = false,
  ) => {
    const retainUnreadable = (error: unknown) => {
      if (!isWorktreePermissionError(error)) {
        return false;
      }
      progress.protect(stage, record.id, "unreadable", `unreadable: ${formatErrorMessage(error)}`);
      return true;
    };
    if (retainUnreadable(initialError)) {
      return;
    }
    let error = initialError;
    if (!(error instanceof WorktreeBranchMovedError)) {
      try {
        if (await hasMissingManagedWorktreeGitdir(record)) {
          await withWorktreeAllocationLease(
            {
              env,
              commitGuard: () => assertOwnerAllowsCleanup(env, record, policy, retiredOwner),
            },
            async (guard) => {
              const token = randomUUID();
              claimWorktreeRemoval(env, { worktreeId: record.id, token });
              try {
                if (!(await hasMissingManagedWorktreeGitdir(record))) {
                  throw new WorktreeRemovalLockError(
                    "busy",
                    "worktree Git metadata changed during cleanup",
                  );
                }
                const retired = await retireMissingRegistryWorktree(env, record, now, () => {
                  guard.commitGuard?.();
                  assertWorktreeRemovalClaim(env, record.id, token);
                });
                if (retired.protection) {
                  progress.protect(stage, record.id, retired.protection);
                  return;
                }
                if (retired.record?.removedAt !== now) {
                  throw new WorktreeRemovalLockError(
                    "busy",
                    "worktree retirement was not admitted",
                  );
                }
                progress.result.orphansRetired += 1;
                progress.result.retiredCheckoutPaths.push(record.path);
                progress.record(
                  "orphans",
                  "retired",
                  `missing-gitdir; checkout files preserved at ${record.path}`,
                  record.id,
                );
              } finally {
                abortWorktreeRemoval(env, record.id, token);
              }
            },
          );
          return;
        }
      } catch (retirementError) {
        if (retainUnreadable(retirementError)) {
          return;
        }
        // An unavailable repository or uncertain repair cannot authorize retirement.
        if (
          retirementError instanceof WorktreeRemovalLockError ||
          retirementError instanceof WorktreeRemovalContentionError
        ) {
          error = retirementError;
        }
      }
      log.warn(`${stage} cleanup failed for ${record.id}: ${String(error)}`);
    }
    progress.error(stage, error, record.id);
  };
}
