import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { startGitOperationTiming } from "../../infra/git-operation-timing.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { withManagedWorktreeGit } from "./checkout-policy.js";
import type { WorktreeCleanupMutation } from "./gc-removal.js";
import { lockState } from "./git-lock.js";
import { repairWorktreePackIndex } from "./git-maintenance.js";
import { commandError, requireGit } from "./git.js";
import { readRegistryWorktreeForMutation, requireActiveWorktreeRecord } from "./registry-read.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  createWorktreeRemovalClaimsGuard,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  updateRegistryWorktree,
} from "./registry.js";
import { WorktreeSnapshotError, WorktreeRemovalLockError } from "./removal-errors.js";
import { finalizeManagedWorktreeRemoval } from "./removal-finalization.js";
import {
  assertExactStateOwner,
  prepareSnapshotBranchDeletion,
  removeManagedCheckout,
  requireExactManagedWorktreeHead,
  requireManagedWorktreeHead,
  retireExactWorktree,
} from "./removal-git.js";
import { abortWorktreeRemoval } from "./run-lease.js";
import { rebindLiveWorktreeRepository } from "./service-preparation.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import {
  captureManagedWorktreeSnapshot,
  verifyManagedWorktreeExactSnapshot,
} from "./snapshot-host.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeRunEndCleanup,
  RemoveManagedWorktreeResult,
  WorktreeWorkerAuthority,
} from "./types.js";

export type RemoveWorktreeParams = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
  workerAuthority?: WorktreeWorkerAuthority;
  id: string;
  reason: string;
  allowSnapshotLoss?: boolean;
  /** Explicit owner-fenced detached retirement; never combined with force or clean-only removal. */
  exactState?: ExactStateRetirement;
  requireLossless?: boolean;
  inspectedHead?: string;
  claimToken?: string;
  rollbackGuard?: () => void;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
  withOwnerMutation?: WorktreeCleanupMutation;
};

export async function removeSettledManagedWorktree(
  input: RemoveWorktreeParams & WorktreeAllocationGuard & { claimToken: string },
  context: {
    env: NodeJS.ProcessEnv;
    now: () => number;
    getConfig: () => OpenClawConfig;
    snapshotRetentionMs: number;
  },
  timing: ReturnType<typeof startGitOperationTiming>,
  prepareArchive?: (snapshot: string) => Promise<void>,
): Promise<RemoveManagedWorktreeResult> {
  const { env, now, getConfig, snapshotRetentionMs } = context;
  let params = input;
  timing?.markRemovalStage("preparation");
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  let record = requireActiveWorktreeRecord(
    params.id,
    await readRegistryWorktreeForMutation({ ...params, env }),
  );
  // Admission already excludes run leases and competing removers. Retain its
  // exact claim through snapshot, deletion, and terminal publication.
  const claimToken = params.claimToken;
  const assertClaim = createWorktreeRemovalClaimsGuard(env, [record.id], claimToken);
  const allocationGuard = params.commitGuard;
  let exactFinalized = false;
  if (params.exactState) {
    const expected = params.exactState;
    const original = record;
    params = {
      ...params,
      workerAuthority: {
        ...params.workerAuthority,
        predicates: [
          ...(params.workerAuthority?.predicates ?? []),
          { kind: "exact-owner", record: original },
        ],
      },
      commitGuard: () => {
        allocationGuard?.();
        if (exactFinalized) {
          return;
        }
        const current = requireActiveWorktreeRecord(params.id, getRegistryWorktree(env, params.id));
        assertExactStateOwner(current, expected);
        if (
          current.path !== original.path ||
          current.branch !== original.branch ||
          current.repoRoot !== original.repoRoot
        ) {
          throw new Error("Worktree exact-state binding changed; checkout preserved");
        }
        assertClaim();
      },
    };
  }
  record = await rebindLiveWorktreeRepository(env, record, params);
  const gitOptions = {
    signal: params.signal,
    beforeRun: params.commitGuard,
    killProcessTree: true,
  };
  return await withManagedWorktreeGit({ record, env, getConfig, ...gitOptions }, async (git) => {
    const pendingRef = `refs/openclaw/removals/${record.id}`;
    const pending = await git.run(
      record.repoRoot,
      ["show-ref", "--verify", "--quiet", pendingRef],
      gitOptions,
    );
    if (pending.code !== 1) {
      if (pending.code !== 0) {
        throw commandError("git show-ref --verify", pending);
      }
      throw new Error(
        `Previous worktree removal may be incomplete; inspect ${record.path} before cleanup. Recovery snapshot preserved at ${pendingRef}.`,
      );
    }
    const checkHead = () =>
      params.exactState
        ? requireExactManagedWorktreeHead(record, params.exactState, gitOptions)
        : requireManagedWorktreeHead(record, gitOptions);
    const head = await checkHead();
    if (params.inspectedHead && params.inspectedHead !== head) {
      throw new Error("Worktree HEAD changed after lossless inspection; checkout preserved.");
    }
    const state = await lockState(record);
    if (state.kind === "live" || state.kind === "foreign") {
      throw new WorktreeRemovalLockError(
        state.kind === "live" ? "busy" : "foreign-lock",
        state.kind === "live"
          ? `worktree is locked by live OpenClaw pid ${state.pid}`
          : `worktree has a foreign lock${state.reason ? `: ${state.reason}` : ""}`,
      );
    }
    if (state.kind !== "none") {
      params.commitGuard?.();
      await git.require(record.repoRoot, ["worktree", "unlock", record.path], {
        signal: params.signal,
        beforeRun: params.commitGuard,
        killProcessTree: true,
      });
    }
    timing?.markRemovalStage("packRepair");
    await repairWorktreePackIndex(record.repoRoot, {
      signal: params.signal,
      commitGuard: params.commitGuard,
    });
    timing?.markRemovalStage("snapshot");
    const retirementName = params.exactState ? `.openclaw-retiring-${randomUUID()}` : undefined;
    let snapshotRef: string | undefined;
    let snapshotError: string | undefined;
    let exactStateDigest: string | undefined;
    let capturedProvisionedPaths: readonly string[] = [];
    try {
      const provisionedPaths = await getRegistryWorktreeProvisionedPaths(env, record.id);
      params.commitGuard?.();
      if (provisionedPaths === undefined) {
        throw new Error("provisioned path ledger is unavailable");
      }
      capturedProvisionedPaths = provisionedPaths;
      const snapshot = await captureManagedWorktreeSnapshot({
        record,
        env,
        reason: params.reason,
        exactState: params.exactState,
        retirementName,
        provisionedPaths,
        git,
        signal: params.signal,
        assertCurrent: params.commitGuard,
        workerAuthority: {
          ...params.workerAuthority,
          predicates: [
            ...(params.workerAuthority?.predicates ?? []),
            { kind: "removal-claim", id: record.id, token: claimToken },
          ],
        },
        requireDiskSpace: params.requireDiskSpace,
        onInventory: (counts) => timing?.recordInventory(counts),
      });
      snapshotRef = snapshot.snapshotRef;
      exactStateDigest = snapshot.exactStateDigest;
      params.commitGuard?.();
      await updateRegistryWorktree(
        env,
        record.id,
        { snapshotRef, provisionedState: snapshot.provisionedState },
        {
          workerAuthority: {
            ...params.workerAuthority,
            predicates: [
              ...(params.workerAuthority.predicates ?? []),
              { kind: "removal-claim", id: record.id, token: claimToken },
            ],
          },
        },
      );
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      snapshotError = error instanceof Error ? error.message : String(error);
      try {
        params.rollbackGuard();
        await clearRegistryWorktreeProvisionedChunks(env, record.id, {
          leaseSet: params.workerAuthority.leaseSet,
          predicates: [{ kind: "removal-claim", id: record.id, token: claimToken }],
        });
      } catch (cleanupError) {
        throw new WorktreeSnapshotError(
          `${snapshotError}; provisioned snapshot cleanup failed: ${String(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      if (!params.allowSnapshotLoss) {
        throw new WorktreeSnapshotError(snapshotError, { cause: error });
      }
      snapshotRef = undefined;
    }
    const snapshot =
      snapshotError || !snapshotRef
        ? undefined
        : await git.require(
            record.repoRoot,
            ["rev-parse", "--verify", `${snapshotRef}^{commit}`],
            gitOptions,
          );
    const deletionOptions =
      snapshot && snapshotRef && !params.exactState
        ? await prepareSnapshotBranchDeletion(record, snapshotRef, snapshot, gitOptions)
        : undefined;
    if (
      (await checkHead()) !== head ||
      (snapshot &&
        (await git.require(record.repoRoot, ["rev-parse", `${snapshot}^`], gitOptions)) !== head)
    ) {
      throw new Error(
        "Worktree HEAD changed after snapshot preparation; checkout and branch preserved.",
      );
    }
    timing?.markRemovalStage("checkoutRemoval");
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    if (params.requireLossless && snapshot) {
      // The snapshot sees hidden index edits that status alone can miss.
      const changed = await git.require(
        record.repoRoot,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", head, snapshot],
        gitOptions,
      );
      if (changed) {
        await abortWorktreeRemoval(env, record.id, claimToken);
        await updateRegistryWorktree(
          env,
          record.id,
          {
            runEndCleanup: { outcome: "retained-dirty", at: now() },
          },
          {
            onlyIfLive: true,
            onlyIfActiveAt: record.lastActiveAt,
            workerAuthority: params.workerAuthority,
          },
        );
        return { removed: false };
      }
    }
    if (snapshot) {
      await prepareArchive?.(snapshot);
    }
    // Pin the completed capture before deletion. Failed or interrupted deletion
    // must never replace it with a snapshot of a partially removed checkout.
    await git.require(
      record.repoRoot,
      ["update-ref", pendingRef, snapshot ?? head, ""],
      gitOptions,
    );
    const finalize = async (recoveryPath?: string) => {
      timing?.markRemovalStage("finalization");
      return await finalizeManagedWorktreeRemoval({
        record,
        env,
        claimToken,
        now,
        snapshotRef,
        snapshotOid: snapshot ?? head,
        snapshotError,
        runEndCleanup: params.runEndCleanup,
        recoveryPath,
        snapshotRetentionMs,
        git: params.exactState ? git.require : requireGit,
        options: params.exactState
          ? gitOptions
          : {
              ...gitOptions,
              signal: undefined,
              beforeRun: () => {
                params.rollbackGuard();
                assertClaim();
              },
            },
        deletionOptions,
        onFinalized: () => {
          exactFinalized = true;
        },
        workerAuthority: {
          leaseSet: params.workerAuthority.leaseSet,
          predicates: [{ kind: "removal-claim", id: record.id, token: claimToken }],
        },
        withOwnerMutation: params.withOwnerMutation,
      });
    };
    const expected = params.exactState;
    if (expected) {
      const digest = exactStateDigest;
      const rollbackGuard = params.rollbackGuard;
      if (!retirementName || !snapshot || !digest || !rollbackGuard) {
        throw new Error(
          "Exact-state snapshot or retirement custody is incomplete; source preserved",
        );
      }
      return await retireExactWorktree({
        record,
        retirementName,
        snapshot,
        git,
        signal: params.signal,
        assertCurrent: () => params.commitGuard?.(),
        assertRollbackCurrent: rollbackGuard,
        finalize,
        verify: async (quarantined) => {
          await verifyManagedWorktreeExactSnapshot({
            record: quarantined,
            expected,
            retirementName,
            expectedDigest: digest,
            provisionedPaths: capturedProvisionedPaths,
            git,
            signal: params.signal,
            assertCurrent: () => params.commitGuard?.(),
          });
          await requireExactManagedWorktreeHead(quarantined, expected, gitOptions);
        },
      });
    }
    await removeManagedCheckout(
      record,
      git,
      params.requireLossless,
      "bounded",
      params.commitGuard,
      params.signal,
    );
    // Admitted deletion must publish its terminal facts even after caller cancellation.
    return await runOutsideCommandProcessScope(() => finalize());
  });
}
