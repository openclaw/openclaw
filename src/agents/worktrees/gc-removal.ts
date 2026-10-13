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
import { prepareWorktreeRegistryGuard } from "./registry-read.js";
import {
  deferFailedWorktreeRemoval,
  deferWorktreeCleanup,
  retireMissingRegistryWorktree,
} from "./registry-retirement.js";
import {
  createWorktreeRemovalClaimsGuard,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import {
  isWorktreePermissionError,
  isWorktreeRepositoryCorruptionError,
  WorktreeBranchMovedError,
  WorktreeRemovalLockError,
} from "./removal-errors.js";
import { requireManagedWorktreeHead } from "./removal-git.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
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

export type WorktreeCleanupMutation = <T>(
  run: () => Promise<T>,
  options?: { settle?: true },
) => Promise<T>;

export type WorktreeCleanupOwnerPolicy = {
  retryDeferred?: boolean;
  prepareOwners?: (
    records: readonly ManagedWorktreeRecord[],
  ) => Promise<Pick<WorktreeCleanupOwnerPolicy, "readOwnerState">>;
  readOwnerState?: (
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ) => "active" | "retired" | "idle" | "other";
  withOwnerCleanup?: <T>(
    record: ManagedWorktreeRecord,
    run: (withOwnerMutation: WorktreeCleanupMutation) => Promise<T>,
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
  let claimed = false;
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
    claimed = true;
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
    if (claimed) {
      await abortWorktreeRemoval(env, id, claimToken);
    } else if (error instanceof WorktreeRemovalContentionError) {
      // A finalized competitor owns the terminal fact; active contenders record retention.
      if (error.kind !== "finalized") {
        await recordOutcome("retained-busy");
      }
      return false;
    }
    try {
      await recordOutcome("failed", error);
    } catch (outcomeError) {
      if (hasSqliteWorkerOutcomeUnknown(outcomeError)) {
        throw outcomeError;
      }
      // Preserve the original failure when outcome writes lose admission or infrastructure.
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

function assertOwnerPolicyAllowsCleanup(
  record: ManagedWorktreeRecord,
  params: WorktreeCleanupOwnerPolicy,
  retiredOwner = false,
) {
  if (record.ownerId === undefined) {
    return;
  }
  const current = params.readOwnerState?.(record.ownerKind, record.ownerId);
  if (current === "active" || (retiredOwner && current !== "retired")) {
    throw new WorktreeRemovalLockError("busy", "worktree owner became active during cleanup");
  }
}

export function createWorktreeGcRemoval(context: {
  env: NodeJS.ProcessEnv;
  records: readonly ManagedWorktreeRecord[];
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
      withOwnerMutation?: WorktreeCleanupMutation;
    },
  ) => Promise<RemoveManagedWorktreeResult>;
}) {
  const { env, now, progress, policy, assertCurrent, signal } = context;
  const registryContext = captureWorktreeRunEndContext(env);
  // The registry owns persistence and revision invalidation; this pass shares its
  // admitted failures so sibling checkouts do not rediscover broken object storage.
  const repositoryFailures = new Map<string, { attempts: number; reason?: string }>();
  for (const record of context.records) {
    if (record.removedAt !== undefined || record.gcRetry?.stage !== "repository-corrupt") {
      continue;
    }
    const previous = repositoryFailures.get(record.repoRoot);
    repositoryFailures.set(record.repoRoot, {
      attempts: Math.max(previous?.attempts ?? 0, record.gcRetry.attempts),
      reason:
        previous?.reason ??
        (!policy.retryDeferred && now < record.gcRetry.retryAt ? record.gcProtection : undefined),
    });
  }
  const withOwnerCleanup = <T>(
    record: ManagedWorktreeRecord,
    run: (withOwnerMutation: WorktreeCleanupMutation) => Promise<T>,
  ) =>
    policy.withOwnerCleanup
      ? policy.withOwnerCleanup(record, run, signal)
      : run((mutation) => mutation());
  const prepareOwnerCurrent = async (record: ManagedWorktreeRecord, retiredOwner = false) => {
    const assertRegistryCurrent = await prepareWorktreeRegistryGuard(registryContext, {
      predicates: [{ kind: "activity", id: record.id, lastActiveAt: record.lastActiveAt }],
      assertCurrent,
    });
    return () => {
      assertRegistryCurrent();
      assertOwnerPolicyAllowsCleanup(record, policy, retiredOwner);
    };
  };
  const ownerGuard = (
    record: ManagedWorktreeRecord,
    retiredOwner: boolean,
    commitGuard: () => void,
  ) => ({
    id: record.id,
    signal,
    workerAuthority: {
      assertCurrent: () => {
        assertCurrent?.();
        assertOwnerPolicyAllowsCleanup(record, policy, retiredOwner);
      },
      predicates: [{ kind: "activity", id: record.id, lastActiveAt: record.lastActiveAt }],
    } satisfies WorktreeWorkerAuthority,
    commitGuard,
  });
  const handleError = async (
    record: ManagedWorktreeRecord,
    initialError: unknown,
    retiredOwner = false,
    withOwnerMutation: WorktreeCleanupMutation = (mutation) => mutation(),
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
    if (isWorktreeRepositoryCorruptionError(initialError)) {
      const reason = `Repository ${record.repoRoot} has missing or corrupt Git objects; repair its object storage, then run openclaw worktrees gc --retry-deferred`;
      const previousAttempts = repositoryFailures.get(record.repoRoot)?.attempts ?? 0;
      const retry = await withOwnerMutation(async () =>
        deferFailedWorktreeRemoval({
          env,
          id: record.id,
          stage: "repository-corrupt",
          reason,
          elapsedMs: 0,
          now,
          previousAttempts,
          assertCurrent: await prepareOwnerCurrent(record, retiredOwner),
        }),
      );
      if (retry) {
        repositoryFailures.set(record.repoRoot, { attempts: retry.attempts, reason });
        log.warn(
          `${reason}; next automatic retry at ${new Date(retry.retryAt).toISOString()}: ${formatErrorMessage(initialError)}`,
        );
      }
      progress.error("idle", `${reason}: ${formatErrorMessage(initialError)}`, record.id);
      return;
    }
    let error = initialError;
    if (error instanceof WorktreeBranchMovedError) {
      await deferWorktreeGcRecord(env, record, "branch-moved", assertCurrent);
    } else {
      try {
        if (await hasMissingManagedWorktreeGitdir(record)) {
          const token = randomUUID();
          const assertOwnerCurrent = await prepareOwnerCurrent(record, retiredOwner);
          const custody = { env, ...ownerGuard(record, retiredOwner, assertOwnerCurrent) };
          await withOwnerMutation(() =>
            claimWorktreeRemoval(env, {
              worktreeId: record.id,
              token,
              assertCurrent: custody.commitGuard,
              workerAuthority: custody.workerAuthority,
            }),
          );
          try {
            await withWorktreeAllocationLease(custody, async (guard) => {
              const assertClaim = createWorktreeRemovalClaimsGuard(env, [record.id], token);
              if (!(await hasMissingManagedWorktreeGitdir(record))) {
                throw new WorktreeRemovalLockError(
                  "busy",
                  "worktree Git metadata changed during cleanup",
                );
              }
              const retired = await withOwnerMutation(() =>
                retireMissingRegistryWorktree(env, record, now, () => {
                  guard.commitGuard?.();
                  assertClaim();
                }),
              );
              if (retired.protection) {
                progress.protect("idle", record.id, retired.protection);
                return;
              }
              if (retired.record?.removedAt !== now) {
                throw new WorktreeRemovalLockError("busy", "worktree retirement was not admitted");
              }
              progress.result.orphansRetired += 1;
              progress.result.retiredCheckoutPaths.push(record.path);
              progress.record(
                "orphans",
                "retired",
                `missing-gitdir; checkout files preserved at ${record.path}`,
                record.id,
              );
            });
          } finally {
            await abortWorktreeRemoval(env, record.id, token);
          }
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
      if (
        /not a git repository|gitfile does not point to a valid repository|^Git metadata is unavailable /u.test(
          formatErrorMessage(error),
        )
      ) {
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
    repositoryProtection: (repoRoot: string) => repositoryFailures.get(repoRoot)?.reason,
    remove: (record: ManagedWorktreeRecord, reason: string, retiredOwner = false) => {
      progress.result.eligibleCount += 1;
      return withOwnerCleanup(record, async (withOwnerMutation) => {
        const assertOwnerCurrent = await prepareOwnerCurrent(record, retiredOwner);
        return context.remove({
          ...ownerGuard(record, retiredOwner, assertOwnerCurrent),
          reason,
          withOwnerMutation,
        });
      });
    },
    retireMissing: (record: ManagedWorktreeRecord) =>
      withOwnerCleanup(record, async (withOwnerMutation) => {
        const assertOwnerCurrent = await prepareOwnerCurrent(record);
        return withOwnerMutation(() =>
          retireMissingRegistryWorktree(env, record, now, assertOwnerCurrent),
        );
      }),
    onError: (record: ManagedWorktreeRecord, error: unknown, retiredOwner = false) =>
      withOwnerCleanup(record, (withOwnerMutation) =>
        handleError(record, error, retiredOwner, withOwnerMutation),
      ),
  };
}
