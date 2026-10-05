import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import {
  hasMissingManagedWorktreeGitdir,
  inspectManagedWorktreeCheckout,
} from "./checkout-inspection.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { deferWorktreeCleanup, retireMissingRegistryWorktree } from "./registry-retirement.js";
import {
  createWorktreeRemovalClaimsGuard,
  getRegistryWorktree,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import {
  isWorktreePermissionError,
  WorktreeBranchMovedError,
  WorktreeRemovalLockError,
} from "./removal-errors.js";
import { requireManagedWorktreeHead } from "./removal-git.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanupOutcome,
  RemoveManagedWorktreeResult,
  WorktreeWorkerAuthority,
} from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export type WorktreeCleanupOwnerPolicy = {
  retryDeferred?: boolean;
  shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  shouldRemoveOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  withOwnerCleanup?: <T>(
    record: ManagedWorktreeRecord,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
};

export async function removeWorktreeIfLossless(
  params: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
    record: ManagedWorktreeRecord;
    env: NodeJS.ProcessEnv;
    now: () => number;
    getConfig: () => OpenClawConfig;
    workerAuthority?: WorktreeWorkerAuthority;
    prepareRecord: (record: ManagedWorktreeRecord) => Promise<ManagedWorktreeRecord>;
    remove: (params: {
      id: string;
      claimToken: string;
      inspectedHead: string;
    }) => Promise<RemoveManagedWorktreeResult>;
  },
): Promise<boolean> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  const { env, now, getConfig } = params;
  let record = params.record;
  const { id } = record;
  const claimToken = randomUUID();
  const recordOutcome = async (outcome: ManagedWorktreeRunEndCleanupOutcome, error?: unknown) => {
    // Retained/failed writes happen after this remover released or aborted its
    // claim, so racing removers may have finalized the row, or removed AND
    // restored it into a new lifecycle. The live condition blocks the first;
    // conditioning on the activity stamp this remover observed blocks the
    // second (restore bumps lastActiveAt). The winning removal persists its
    // outcome atomically inside remove()'s finalization update, never here.
    await updateRegistryWorktree(
      env,
      id,
      {
        runEndCleanup: {
          outcome,
          at: now(),
          ...(outcome === "failed"
            ? { reason: truncateUtf16Safe(formatErrorMessage(error), 500) }
            : {}),
        },
      },
      {
        onlyIfLive: true,
        onlyIfActiveAt: record.lastActiveAt,
        assertCurrent,
        workerAuthority: params.workerAuthority ?? { assertCurrent },
      },
    );
  };
  // Run-end cleanup must leave a durable outcome even when safety retains the checkout.
  // QA and operators observe this product-boundary fact through worktrees.list.
  try {
    await claimWorktreeRemoval(env, {
      worktreeId: id,
      token: claimToken,
      assertCurrent,
      workerAuthority: {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : assertCurrent,
        predicates: [...(params.workerAuthority?.predicates ?? []), { kind: "binding", record }],
      },
    });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    if (error instanceof WorktreeRemovalContentionError) {
      if (error.kind === "finalized") {
        // The winning remover owns the terminal cleanup fact; a late contender
        // must return without replacing it with a false retained/failed outcome.
        return false;
      }
      // A live run lease or a competing remover holds the worktree; a lossless
      // auto-cleanup must not race it.
      await recordOutcome("retained-busy");
      return false;
    }
    try {
      await recordOutcome("failed", error);
    } catch (outcomeError) {
      if (hasSqliteWorkerOutcomeUnknown(outcomeError)) {
        throw outcomeError;
      }
      // Preserve the claim failure when the same infrastructure blocks recording it.
    }
    throw error;
  }
  try {
    record = await params.prepareRecord(record);
    const inspectedHead = await requireManagedWorktreeHead(record, {
      signal: params.signal,
      beforeRun: assertCurrent,
    });
    const inspection = await inspectManagedWorktreeCheckout(record, "lossless", {
      env,
      getConfig,
      signal: params.signal,
      beforeRun: assertCurrent,
    });
    assertCurrent();
    const retainedOutcome =
      inspection.retainedReason === "nested-repository"
        ? "retained-dirty"
        : inspection.retainedReason === undefined
          ? undefined
          : (`retained-${inspection.retainedReason}` as const);
    if (retainedOutcome) {
      await abortWorktreeRemoval(env, id, claimToken);
      await recordOutcome(retainedOutcome);
      return false;
    }
    const result = await params.remove({
      id,
      claimToken,
      inspectedHead,
    });
    return result.removed;
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    await abortWorktreeRemoval(env, id, claimToken);
    try {
      await recordOutcome("failed", error);
    } catch (outcomeError) {
      if (hasSqliteWorkerOutcomeUnknown(outcomeError)) {
        throw outcomeError;
      }
      // Exact-claim cleanup survives caller revocation; new outcome writes do not.
    }
    throw error;
  }
}

export async function deferWorktreeGcRecord(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  reason: string | null,
  assertCurrent?: () => void,
) {
  if (
    (await deferWorktreeCleanup(env, { observed: record, reason }, assertCurrent)) &&
    reason !== null
  ) {
    log.warn(
      `cleanup deferred for ${record.id}: ${reason}; checkout preserved at ${record.path}. After repair, run openclaw worktrees gc --retry-deferred to retry.`,
    );
  }
}

function assertOwnerAllowsCleanup(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  params: WorktreeCleanupOwnerPolicy,
  retiredOwner = false,
) {
  if (getRegistryWorktree(env, record.id)?.lastActiveAt !== record.lastActiveAt) {
    throw new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
  }
  assertOwnerPolicyAllowsCleanup(record, params, retiredOwner);
}

function assertOwnerPolicyAllowsCleanup(
  record: ManagedWorktreeRecord,
  params: WorktreeCleanupOwnerPolicy,
  retiredOwner = false,
) {
  if (
    record.ownerId !== undefined &&
    (params.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true ||
      (retiredOwner && params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) !== true))
  ) {
    throw new WorktreeRemovalLockError("busy", "worktree owner became active during cleanup");
  }
}

export function createWorktreeGcRemoval(context: {
  env: NodeJS.ProcessEnv;
  now: number;
  progress: WorktreeGcProgress;
  policy: WorktreeCleanupOwnerPolicy;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  remove: (
    params: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
      id: string;
      reason: string;
      workerAuthority?: WorktreeWorkerAuthority;
    },
  ) => Promise<RemoveManagedWorktreeResult>;
}) {
  const { env, now, progress, policy, assertCurrent, signal } = context;
  const withOwnerCleanup = <T>(record: ManagedWorktreeRecord, run: () => Promise<T>) =>
    policy.withOwnerCleanup ? policy.withOwnerCleanup(record, run, signal) : run();
  const assertOwnerCurrent = (record: ManagedWorktreeRecord, retiredOwner = false) => {
    assertCurrent?.();
    assertOwnerAllowsCleanup(env, record, policy, retiredOwner);
  };
  const handleError = async (
    record: ManagedWorktreeRecord,
    initialError: unknown,
    retiredOwner = false,
  ) => {
    assertCurrent?.();
    const retainUnreadable = (error: unknown) => {
      if (!isWorktreePermissionError(error)) {
        return false;
      }
      progress.protect("idle", record.id, "unreadable", `unreadable: ${formatErrorMessage(error)}`);
      return true;
    };
    if (retainUnreadable(initialError)) {
      return;
    }
    let error = initialError;
    if (error instanceof WorktreeBranchMovedError) {
      await deferWorktreeGcRecord(env, record, "branch-moved", assertCurrent);
    } else {
      try {
        if (await hasMissingManagedWorktreeGitdir(record)) {
          await withWorktreeAllocationLease(
            {
              env,
              id: record.id,
              signal,
              workerAuthority: {
                assertCurrent: () => {
                  assertCurrent?.();
                  assertOwnerPolicyAllowsCleanup(record, policy, retiredOwner);
                },
                predicates: [
                  { kind: "activity", id: record.id, lastActiveAt: record.lastActiveAt },
                ],
              },
              commitGuard: () => assertOwnerCurrent(record, retiredOwner),
            },
            async (guard) => {
              const token = randomUUID();
              await claimWorktreeRemoval(env, {
                worktreeId: record.id,
                token,
                assertCurrent: guard.commitGuard,
                workerAuthority: guard.workerAuthority,
              });
              const assertClaim = createWorktreeRemovalClaimsGuard(env, [record.id], token);
              try {
                if (!(await hasMissingManagedWorktreeGitdir(record))) {
                  throw new WorktreeRemovalLockError(
                    "busy",
                    "worktree Git metadata changed during cleanup",
                  );
                }
                const retired = await retireMissingRegistryWorktree(env, record, now, () => {
                  guard.commitGuard?.();
                  assertClaim();
                });
                if (retired.protection) {
                  progress.protect("idle", record.id, retired.protection);
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
                await abortWorktreeRemoval(env, record.id, token);
              }
            },
          );
          return;
        }
      } catch (retirementError) {
        assertCurrent?.();
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
      log.warn(`idle cleanup failed for ${record.id}: ${String(error)}`);
      if (/not a git repository|^Git metadata is unavailable /u.test(formatErrorMessage(error))) {
        await deferWorktreeGcRecord(
          env,
          record,
          "Git metadata unavailable; repair and run openclaw worktrees gc --retry-deferred",
          assertCurrent,
        );
      }
    }
    progress.error("idle", error, record.id);
  };
  return {
    remove: (record: ManagedWorktreeRecord, reason: string, retiredOwner = false) =>
      withOwnerCleanup(record, () =>
        context.remove({
          id: record.id,
          reason,
          signal,
          workerAuthority: {
            assertCurrent: () => {
              assertCurrent?.();
              assertOwnerPolicyAllowsCleanup(record, policy, retiredOwner);
            },
            predicates: [{ kind: "activity", id: record.id, lastActiveAt: record.lastActiveAt }],
          },
          commitGuard: () => assertOwnerCurrent(record, retiredOwner),
        }),
      ),
    retireMissing: (record: ManagedWorktreeRecord) =>
      withOwnerCleanup(record, () =>
        retireMissingRegistryWorktree(env, record, now, () => assertOwnerCurrent(record)),
      ),
    onError: (...args: Parameters<typeof handleError>) =>
      withOwnerCleanup(args[0], () => handleError(...args)),
  };
}
