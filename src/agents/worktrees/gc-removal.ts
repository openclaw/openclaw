import { createHash, randomUUID } from "node:crypto";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withWorktreeMutationLease } from "./allocation.js";
import {
  hasMissingManagedWorktreeGitdir,
  inspectManagedWorktreeCheckout,
} from "./checkout-inspection.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { worktreePathExists } from "./git.js";
import { createManagedWorktreeOwnerPolicy, type WorktreeOwnerCleanup } from "./owner-protection.js";
import { prepareWorktreeRegistryGuard, readRegistryWorktreeForMutation } from "./registry-read.js";
import {
  deferFailedWorktreeRemoval,
  deferWorktreeCleanup,
  retireMissingRegistryWorktree,
  worktreeCleanupProtection,
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
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
  ManagedWorktreeRunEndCleanupOutcome,
  RemoveManagedWorktreeResult,
  WorktreeCleanupMutation,
  WorktreeCleanupOwnerPolicy,
  WorktreeMutationGuard,
  WorktreeWorkerAuthority,
} from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export type ManagedWorktreeGcParams = WorktreeCleanupOwnerPolicy &
  WorktreeMutationGuard & {
    beforeTemplateRemoval?: () => Promise<void>;
    checkpoint?: (progress: ManagedWorktreeGcResult) => Promise<void>;
  };

export type WorktreeLosslessRemovalOptions = WorktreeMutationGuard & {
  ownerCleanup?: WorktreeOwnerCleanup;
  onCleanup?: (cleanup: ManagedWorktreeRunEndCleanup) => void;
};

export async function removeWorktreeIfLossless(
  params: WorktreeLosslessRemovalOptions & {
    record: ManagedWorktreeRecord;
    env: NodeJS.ProcessEnv;
    getConfig: () => OpenClawConfig;
    prepareRecord: (
      record: ManagedWorktreeRecord,
      assertCurrent: () => void,
    ) => Promise<ManagedWorktreeRecord>;
    remove: (params: {
      id: string;
      claimToken: string;
      inspectedHead: string;
      commitGuard: () => void;
      workerAuthority?: WorktreeWorkerAuthority;
      withOwnerMutation?: WorktreeCleanupMutation;
      requireIgnoredCustody?: boolean;
      requireLossless: true;
      runEndCleanup: ManagedWorktreeRunEndCleanup;
    }) => Promise<RemoveManagedWorktreeResult>;
  },
): Promise<boolean> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  const { env, getConfig, ownerCleanup } = params;
  if (
    ownerCleanup &&
    (!Number.isSafeInteger(ownerCleanup.terminalBefore) ||
      ownerCleanup.terminalBefore < 0 ||
      ownerCleanup.terminalBefore > Date.now() - 24 * 60 * 60 * 1000)
  ) {
    throw new Error("ownerCleanup.terminalBefore must be epoch milliseconds at least 24 hours ago");
  }
  const policy = ownerCleanup
    ? createManagedWorktreeOwnerPolicy(getConfig(), ownerCleanup)
    : undefined;
  let record = params.record;
  const { id } = record;
  const claimToken = randomUUID();
  const recordOutcome = async (
    outcome: ManagedWorktreeRunEndCleanupOutcome,
    error?: unknown,
    persist = true,
  ) => {
    const cleanup = {
      outcome,
      at: Date.now(),
      ...(error === undefined ? {} : { reason: truncateUtf16Safe(formatErrorMessage(error), 500) }),
    };
    // Do not overwrite a winning removal or a restored lifecycle. Retention
    // records use caller authority, not the owner facts that just invalidated removal.
    if (persist) {
      await updateRegistryWorktree(
        env,
        id,
        { runEndCleanup: cleanup },
        {
          onlyIfLive: true,
          onlyIfActiveAt: record.lastActiveAt,
          assertCurrent,
          workerAuthority: params.workerAuthority ?? { assertCurrent },
        },
      );
    }
    // A newer lifecycle can suppress the durable write, never this attempt's receipt.
    params.onCleanup?.(cleanup);
  };
  let claimed = false;
  let preparedOwner = false;
  try {
    if (policy) {
      const protection = record.gcProtection;
      if (protection) {
        await recordOutcome("retained-busy", protection);
        return false;
      }
    }
    const remove = async (withOwnerMutation?: WorktreeCleanupMutation) => {
      preparedOwner = true;
      const registryCurrent = policy
        ? await prepareWorktreeRegistryGuard(captureWorktreeRunEndContext(env), {
            predicates: [{ kind: "binding", record }],
            assertCurrent,
          })
        : assertCurrent;
      const assertRemovalCurrent = () => {
        registryCurrent();
        if (
          policy &&
          (!record.ownerId || policy.readOwnerState(record.ownerKind, record.ownerId) === "active")
        ) {
          throw new WorktreeRemovalLockError(
            "busy",
            "owner is unavailable, active, changed, or not terminal and idle before the cutoff",
          );
        }
      };
      const claimAuthority: WorktreeWorkerAuthority = {
        ...params.workerAuthority,
        assertCurrent: policy
          ? assertRemovalCurrent
          : (params.workerAuthority?.assertCurrent ?? assertRemovalCurrent),
        predicates: [...(params.workerAuthority?.predicates ?? []), { kind: "binding", record }],
      };
      const workerAuthority = policy ? claimAuthority : params.workerAuthority;
      // Check before waiting on the lifecycle, then again inside the atomic claim.
      assertRemovalCurrent();
      const claim = () =>
        claimWorktreeRemoval(env, {
          worktreeId: id,
          token: claimToken,
          assertCurrent: assertRemovalCurrent,
          workerAuthority: claimAuthority,
        });
      await (withOwnerMutation ? withOwnerMutation(claim) : claim());
      claimed = true;
      record = await params.prepareRecord(record, assertRemovalCurrent);
      const inspectedHead = await requireManagedWorktreeHead(record, {
        signal: params.signal,
        beforeRun: assertRemovalCurrent,
      });
      const inspection = await inspectManagedWorktreeCheckout(record, "lossless", {
        env,
        getConfig,
        signal: params.signal,
        beforeRun: assertRemovalCurrent,
      });
      assertRemovalCurrent();
      const retainedOutcome =
        inspection.retainedReason === "nested-repository" ||
        inspection.retainedReason === "ignored-files"
          ? "retained-dirty"
          : inspection.retainedReason === undefined
            ? undefined
            : (`retained-${inspection.retainedReason}` as const);
      if (retainedOutcome) {
        await abortWorktreeRemoval(env, id, claimToken);
        claimed = false;
        await recordOutcome(retainedOutcome);
        return false;
      }
      const cleanup: ManagedWorktreeRunEndCleanup = { outcome: "removed-lossless", at: Date.now() };
      const result = await params.remove({
        id,
        claimToken,
        inspectedHead,
        commitGuard: assertRemovalCurrent,
        workerAuthority,
        withOwnerMutation,
        requireIgnoredCustody: Boolean(policy),
        requireLossless: true,
        runEndCleanup: cleanup,
      });
      if (result.removed) {
        params.onCleanup?.(cleanup);
      } else {
        await abortWorktreeRemoval(env, id, claimToken);
        claimed = false;
        if (result.cleanup) {
          params.onCleanup?.(result.cleanup);
        } else {
          await recordOutcome("retained-busy", result.preserved?.reason ?? "cleanup not admitted");
        }
      }
      return result.removed;
    };
    return await (policy ? policy.withOwnerCleanup(record, remove, params.signal) : remove());
  } catch (error) {
    if (hasWorktreeUnknownOutcome(error)) {
      // Do not release custody or replay an effect whose settlement is unknown.
      throw error;
    }
    if (claimed) {
      await abortWorktreeRemoval(env, id, claimToken);
    }
    const contention = error instanceof WorktreeRemovalContentionError;
    const ownerRetained =
      policy &&
      (!preparedOwner ||
        collectNestedErrorCandidates(error).some(
          (cause) =>
            cause instanceof WorktreeRemovalLockError ||
            cause instanceof WorktreeRemovalContentionError,
        ));
    if ((!claimed && contention) || ownerRetained) {
      assertCurrent();
      await recordOutcome("retained-busy", error, !contention || error.kind !== "finalized");
      return false;
    }
    try {
      await recordOutcome("failed", error);
    } catch (outcomeError) {
      if (hasWorktreeUnknownOutcome(outcomeError)) {
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
  expiresBefore: number;
  ownerCensus?: Pick<WorktreeCleanupOwnerPolicy, "readOwnerState" | "readOwnerActivityAt">;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  remove: (
    params: Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
      id: string;
      reason: string;
      workerAuthority?: WorktreeWorkerAuthority;
      withOwnerMutation?: WorktreeCleanupMutation;
      runEndCleanup?: ManagedWorktreeRunEndCleanup;
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
      reason: previous?.reason ?? worktreeCleanupProtection(record, now, policy.retryDeferred),
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
  const ownerGuard = (record: ManagedWorktreeRecord, commitGuard: () => void) => ({
    id: record.id,
    signal,
    workerAuthority: {
      assertCurrent: commitGuard,
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
    if (hasWorktreeUnknownOutcome(initialError)) {
      throw initialError;
    }
    const { RejectedLocalWorkspaceResultError } =
      await import("../../gateway/worker-environments/local-workspace-checkpoint.js");
    const rejected = collectNestedErrorCandidates(initialError).find(
      (error) => error instanceof RejectedLocalWorkspaceResultError,
    );
    if (rejected) {
      const reason =
        `Workspace result too large to apply automatically; reserved result ${rejected.resultRef}; ` +
        `files preserved at ${rejected.projectionPath}. Reduce the change and checkpoint it, or recover manually, then run openclaw worktrees gc --retry-deferred. ${rejected.message}`;
      await withOwnerMutation(async () => {
        const commitGuard = await prepareOwnerCurrent(record, retiredOwner);
        // Archive preparation may have saved a new snapshot before rejecting its overlay.
        const current = await readRegistryWorktreeForMutation({ env, id: record.id, commitGuard });
        if (current) {
          await deferWorktreeGcRecord(env, current, reason, commitGuard);
        }
      });
      progress.protect("idle", record.id, reason);
      return;
    }
    if (retiredOwner && !(initialError instanceof WorktreeRemovalContentionError)) {
      try {
        await withOwnerMutation(async () => {
          const commitGuard = await prepareOwnerCurrent(record, true);
          await updateRegistryWorktree(
            env,
            record.id,
            {
              runEndCleanup: {
                outcome: "failed",
                at: Date.now(),
                reason: truncateUtf16Safe(formatErrorMessage(initialError), 500),
              },
            },
            {
              onlyIfLive: true,
              onlyIfActiveAt: record.lastActiveAt,
              assertCurrent: commitGuard,
              workerAuthority: ownerGuard(record, commitGuard).workerAuthority,
            },
          );
        });
      } catch (outcomeError) {
        if (hasWorktreeUnknownOutcome(outcomeError)) {
          throw outcomeError;
        }
        log.warn(
          `cleanup outcome could not be recorded for ${record.id}: ${formatErrorMessage(outcomeError)}`,
        );
      }
    }
    const retainUnreadable = async (error: unknown) => {
      if (!isWorktreePermissionError(error)) {
        return false;
      }
      await withOwnerMutation(async () =>
        deferFailedWorktreeRemoval({
          env,
          id: record.id,
          stage: "permission-denied",
          reason:
            `Checkout preserved: permission-denied; ${truncateUtf16Safe(formatErrorMessage(error), 500)}; ` +
            "repair access, then run openclaw worktrees gc --retry-deferred",
          elapsedMs: 0,
          now,
          previousAttempts: record.gcRetry?.attempts ?? 0,
          assertCurrent: await prepareOwnerCurrent(record, retiredOwner),
        }),
      );
      progress.protect("idle", record.id, "unreadable", `unreadable: ${formatErrorMessage(error)}`);
      return true;
    };
    if (await retainUnreadable(initialError)) {
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
          `${reason}; ${retry.retryAt === null ? "automatic retries stopped" : `next automatic retry at ${new Date(retry.retryAt).toISOString()}`}: ${formatErrorMessage(initialError)}`,
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
          const custody = { env, ...ownerGuard(record, assertOwnerCurrent) };
          await withOwnerMutation(() =>
            claimWorktreeRemoval(env, {
              worktreeId: record.id,
              token,
              assertCurrent: custody.commitGuard,
              workerAuthority: custody.workerAuthority,
            }),
          );
          try {
            await withWorktreeMutationLease({ ...custody, id: record.id }, async (guard) => {
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
        if (await retainUnreadable(retirementError)) {
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
  const repositoryProtection = (repoRoot: string) => repositoryFailures.get(repoRoot)?.reason;
  return {
    collect: async (
      protect: (record: ManagedWorktreeRecord) => Promise<string | undefined>,
      checkpoint?: () => Promise<void> | undefined,
    ) => {
      // Keep cold classification serial: each candidate can request several Git processes.
      const evictedIds = new Set(progress.result.removed);
      for (const record of context.records) {
        assertCurrent?.();
        if (evictedIds.has(record.id)) {
          continue;
        }
        let retiredOwner = false;
        try {
          const deferred = worktreeCleanupProtection(record, now, policy.retryDeferred);
          if (deferred && record.gcRetry?.stage !== "nested-repository") {
            progress.protect("idle", record.id, deferred);
            continue;
          }
          if (record.removedAt === undefined && !(await worktreePathExists(record.path))) {
            const retired = await withOwnerCleanup(record, async (withOwnerMutation) => {
              const assertOwnerCurrent = await prepareOwnerCurrent(record);
              return withOwnerMutation(() =>
                retireMissingRegistryWorktree(env, record, now, assertOwnerCurrent),
              );
            });
            if (retired.protection) {
              progress.protect("idle", record.id, retired.protection);
            } else if (retired.record?.removedAt === now) {
              progress.result.orphansRetired += 1;
            }
            continue;
          }
          // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
          const expiresWhenIdle =
            record.ownerKind === "workboard" || record.ownerKind === "session";
          if (record.removedAt !== undefined || !expiresWhenIdle) {
            continue;
          }
          const ownerState =
            record.ownerId === undefined
              ? undefined
              : context.ownerCensus?.readOwnerState?.(record.ownerKind, record.ownerId);
          retiredOwner = ownerState === "retired";
          if (ownerState === "active") {
            progress.protect("idle", record.id, "owner is active");
            continue;
          }
          // Stable per-checkout jitter spreads a busy day's seven-day expiry
          // across an extra hour without ever shortening retention.
          const idleJitterMs =
            createHash("sha256").update(record.id).digest().readUInt32BE(0) % 3_600_000;
          const ownerActivityAt =
            record.ownerKind === "session" && record.ownerId !== undefined
              ? context.ownerCensus?.readOwnerActivityAt?.(record.ownerId)
              : undefined;
          // A terminal run status still belongs to a resumable conversation.
          const lastActiveAt = Math.max(
            record.lastActiveAt,
            Number.isFinite(ownerActivityAt) ? (ownerActivityAt ?? 0) : 0,
          );
          const idle = lastActiveAt + idleJitterMs < context.expiresBefore;
          if (retiredOwner || idle) {
            // Capacity eviction and idle cleanup share one decision per record per pass.
            if (!progress.start(record.id)) {
              continue;
            }
            const repositoryReason = repositoryProtection(record.repoRoot);
            if (repositoryReason) {
              progress.protect("idle", record.id, repositoryReason);
              continue;
            }
            const protection = await protect(record);
            if (protection !== undefined) {
              progress.protect("idle", record.id, protection);
              continue;
            }
            progress.result.eligibleCount += 1;
            // Wait outside owner/checkout custody; removal still acquires and
            // validates live authority after admission.
            await policy.beforeRemoval?.(record);
            const result = await withOwnerCleanup(record, async (withOwnerMutation) => {
              const assertOwnerCurrent = await prepareOwnerCurrent(record, retiredOwner);
              return context.remove({
                ...ownerGuard(record, assertOwnerCurrent),
                reason: retiredOwner ? "owner-gc" : "idle-gc",
                withOwnerMutation,
                ...(retiredOwner
                  ? { runEndCleanup: { outcome: "removed-lossless" as const, at: Date.now() } }
                  : {}),
              });
            });
            if (result.removed) {
              progress.result.removed.push(record.id);
            }
          }
        } catch (error) {
          await withOwnerCleanup(record, (withOwnerMutation) =>
            handleError(record, error, retiredOwner, withOwnerMutation),
          );
        } finally {
          await checkpoint?.();
        }
      }
    },
  };
}
