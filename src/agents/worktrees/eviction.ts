import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import { WorktreeRemovalContentionError } from "./errors.js";
import type { WorktreeEvictionReason } from "./git-worktree-operations.js";
import { readRegistryWorktrees } from "./registry-read.js";
import {
  createWorktreeRemovalClaimsGuard,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  updateRegistryWorktree,
} from "./registry.js";
import { withWorktreeRunEnd } from "./run-end-lifecycle.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  finalizeWorktreeRemoval,
} from "./run-lease.js";
import { captureManagedWorktreeSnapshot } from "./snapshot-host.js";
import type {
  ManagedWorktreeRecord,
  WorktreeRegistryPredicate,
  WorktreeWorkerAuthority,
} from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

/** Capacity eviction keeps run exclusion but deliberately permits loss of unsaved data. */
export async function evictManagedWorktree(params: {
  env: NodeJS.ProcessEnv;
  record: ManagedWorktreeRecord;
  reason: WorktreeEvictionReason;
  guard: WorktreeAllocationGuard;
  getConfig: () => OpenClawConfig;
  now: () => number;
}): Promise<WorktreeEvictionReason | "dirty-purged"> {
  return withWorktreeRunEnd(params.env, () => evictAcceptedWorktree(params));
}

async function evictAcceptedWorktree(
  params: Parameters<typeof evictManagedWorktree>[0],
): Promise<WorktreeEvictionReason | "dirty-purged"> {
  const { env, record, guard } = params;
  const authority = guard.workerAuthority;
  if (!authority?.leaseSet) {
    throw new Error("Worktree eviction requires the allocation lease's worker authority");
  }
  const token = randomUUID();
  const dependencies: string[] = [];
  const claimsPredicate = (): WorktreeRegistryPredicate => ({
    kind: "removal-claims",
    ids: [record.id, ...dependencies],
    token,
  });
  const workerAuthority: WorktreeWorkerAuthority = {
    ...authority,
    predicates: [...(authority.predicates ?? []), { kind: "binding", record }],
  };
  let assertClaims = createWorktreeRemovalClaimsGuard(env, [record.id], token);
  const assertCurrent = () => {
    guard.commitGuard();
    const current = getRegistryWorktree(env, record.id);
    if (
      !current ||
      current.removedAt !== undefined ||
      current.path !== record.path ||
      current.repoRoot !== record.repoRoot ||
      current.createdAt !== record.createdAt ||
      current.lastActiveAt !== record.lastActiveAt
    ) {
      throw new Error("Worktree changed before capacity eviction; retry allocation");
    }
    assertClaims();
  };
  await claimWorktreeRemoval(env, {
    worktreeId: record.id,
    token,
    assertCurrent: guard.commitGuard,
    workerAuthority,
  });
  let outcome:
    | { ok: true; value: WorktreeEvictionReason | "dirty-purged" }
    | { ok: false; error: unknown };
  try {
    assertCurrent();
    const { withSettledLocalWorkspace } =
      await import("../../gateway/worker-environments/local-workspace-projection.js");
    const value = await withSettledLocalWorkspace<WorktreeEvictionReason | "dirty-purged">(
      { worktree: record, env, assertCurrent, workerAuthority, retireRuntime: true },
      async (accepted) => {
        const ownerAuthority = accepted?.workerAuthority ?? workerAuthority;
        const heldClaimsAuthority = (): WorktreeWorkerAuthority => ({
          ...ownerAuthority,
          predicates: [...(ownerAuthority.predicates ?? []), claimsPredicate()],
        });
        const beforeRun = () => {
          assertCurrent();
          accepted?.assertCurrent();
        };
        let snapshotRef: string | undefined;
        let dirty = false;
        let snapshotError: string | undefined;
        try {
          const signal = AbortSignal.any([
            ...(guard.signal ? [guard.signal] : []),
            AbortSignal.timeout(5_000),
          ]);
          await withManagedWorktreeGit(
            { record, env, getConfig: params.getConfig, signal, beforeRun },
            async (git) => {
              const provisionedPaths = await getRegistryWorktreeProvisionedPaths(env, record.id);
              if (!provisionedPaths) {
                throw new Error("provisioned path ledger is unavailable");
              }
              const snapshot = await captureManagedWorktreeSnapshot({
                record,
                env,
                reason: `capacity-${params.reason}`,
                provisionedPaths,
                git,
                signal,
                assertCurrent: beforeRun,
                workerAuthority: heldClaimsAuthority(),
                requireDiskSpace: guard.requireDiskSpace,
              });
              snapshotRef = snapshot.snapshotRef;
              beforeRun();
              await updateRegistryWorktree(
                env,
                record.id,
                { snapshotRef, provisionedState: snapshot.provisionedState },
                { assertCurrent: beforeRun, workerAuthority: heldClaimsAuthority() },
              );
              dirty = Boolean(
                await git.require(
                  record.repoRoot,
                  [
                    "diff-tree",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    `${snapshotRef}^`,
                    snapshotRef,
                  ],
                  { signal, beforeRun },
                ),
              );
              if (accepted) {
                const snapshotCommit = await git.require(
                  record.repoRoot,
                  ["rev-parse", `${snapshotRef}^{commit}`],
                  { signal, beforeRun },
                );
                await accepted.prepareArchive?.(snapshotCommit);
              }
            },
          );
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          beforeRun();
          snapshotError = String(error);
        }
        beforeRun();
        const live = await readRegistryWorktrees(env, { liveOnly: true });
        const liveIds = new Set(live.map((candidate) => candidate.id));
        beforeRun();
        // Cancellation can stop preparation, but never abandon an admitted deletion.
        const settleGuard = () => {
          guard.rollbackGuard();
          assertClaims();
        };
        let deletionAdmitted = false;
        const assertEffectCurrent = () => (deletionAdmitted ? settleGuard() : beforeRun());
        const fenceDependencies = async (ids: string[]) => {
          for (const id of ids) {
            if (id === record.id || !liveIds.has(id)) {
              throw new Error("Worktree dependency is outside the admitted inventory");
            }
            try {
              await claimWorktreeRemoval(env, {
                worktreeId: id,
                token,
                assertCurrent: assertEffectCurrent,
                workerAuthority: deletionAdmitted
                  ? {
                      leaseSet: authority.leaseSet,
                      predicates: [{ kind: "binding", record }, claimsPredicate()],
                    }
                  : heldClaimsAuthority(),
              });
            } catch (error) {
              if (error instanceof WorktreeRemovalContentionError && error.blockedByRun) {
                log.warn(
                  `Worktree eviction live-refused: ${record.id}; dependency ${error.blockedByRun.worktreeId}; live pid ${error.blockedByRun.pid}`,
                );
              }
              throw error;
            }
            dependencies.push(id);
            assertClaims = createWorktreeRemovalClaimsGuard(
              env,
              [record.id, ...dependencies],
              token,
            );
            if (dependencies.length % 8 === 0) {
              await yieldTurn();
            }
          }
          assertEffectCurrent();
        };
        await runOutsideCommandProcessScope(() =>
          runGitWorkerOperation(
            { type: "worktree.eviction-purge", input: { record, live } },
            {
              assertCurrent: assertEffectCurrent,
              onEffect: async (effect) => {
                assertEffectCurrent();
                if (effect.type === "worktree.eviction-fence") {
                  await fenceDependencies(effect.input.worktreeIds);
                } else if (effect.type === "worktree.eviction-admit") {
                  deletionAdmitted = true;
                }
              },
            },
          ),
        );
        settleGuard();
        const removedAt = params.now();
        await updateRegistryWorktree(
          env,
          record.id,
          { removedAt, snapshotRef },
          {
            assertCurrent: settleGuard,
            removalToken: token,
            workerAuthority: {
              leaseSet: authority.leaseSet,
              predicates: [{ kind: "binding", record }, claimsPredicate()],
            },
          },
        );
        await finalizeWorktreeRemoval(
          env,
          { worktreeId: record.id, lastActiveAt: record.lastActiveAt, removedAt, token },
          // Deletion already holds custody; caller cancellation cannot abandon its settlement.
          { leaseSet: authority.leaseSet, predicates: [claimsPredicate()] },
        );
        const reason = dirty || snapshotError ? "dirty-purged" : params.reason;
        log.warn(
          `Worktree evicted: ${record.id}; reason ${reason}; selected ${params.reason}; ${snapshotRef ? `snapshot ${snapshotRef}` : "no recovery snapshot"}${snapshotError ? `; snapshot failed: ${snapshotError}` : ""}`,
        );
        return reason;
      },
    );
    outcome = { ok: true, value };
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    outcome = { ok: false, error };
  }
  const errors: unknown[] = outcome.ok ? [] : [outcome.error];
  for (const [index, id] of [...dependencies, record.id].entries()) {
    try {
      await abortWorktreeRemoval(env, id, token);
    } catch (error) {
      errors.push(error);
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        break;
      }
    }
    if ((index + 1) % 8 === 0) {
      await yieldTurn();
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worktree eviction or claim release failed", {
      cause: errors[0],
    });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (errors.length > 0) {
    throw errors[0];
  }
  return outcome.value;
}
