import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { estimateWorktreeCheckoutTransitionBytes, requireAllocationSpace } from "./capacity.js";
import { usesSourceOnlyWorktreeGit } from "./checkout-policy.js";
import { addManagedWorktree, materializeManagedWorktree } from "./checkout.js";
import {
  requireGit,
  worktreePathExists,
  commandError,
  listGitWorktrees,
  lstatIfExists,
  runGit,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";
import { restoreProvisionedFiles } from "./provisioned-files.js";
import { SNAPSHOT_CHUNK_BYTES } from "./provisioned-snapshot.js";
import { readRegistryWorktreeForMutation } from "./registry-read.js";
import {
  createWorktreeRemovalClaimsGuard,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedState,
  updateRegistryWorktree,
} from "./registry.js";
import {
  assertExactStateOwner,
  assertExactStateSourceIdentity,
  restoreRetiredExactWorktree,
  requireExactWorktreeRepository,
} from "./removal-git.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  finalizeWorktreeRemoval,
} from "./run-lease.js";
import {
  removeFailedWorktree,
  resolveRepository,
  withWorktreeSources,
  type ResolvedRepository,
} from "./service-preparation.js";
import {
  exactStateRetirementSchema,
  type ExactStateRetirement,
} from "./snapshot-exact-state-contract.js";
import { readExactStateSnapshot, type ExactStateSnapshot } from "./snapshot-exact-state.js";
import { assertExactSnapshotRecordCurrent } from "./snapshot-host.js";
import {
  clearExactRestoreReceipt,
  readExactRestoreReceipt,
  restoreExactSnapshotFallback,
} from "./snapshot-restore-exact.js";
import type { ManagedWorktreeRecord } from "./types.js";

function requireLiveSnapshotRecord(env: NodeJS.ProcessEnv, id: string): ManagedWorktreeRecord {
  const record = getRegistryWorktree(env, id);
  if (!record || record.removedAt !== undefined) {
    throw new Error("Worktree lifecycle changed during recovery");
  }
  return record;
}

export function requireManagedWorktreeRestoreRecord(
  id: string,
  record: ManagedWorktreeRecord | undefined,
): ManagedWorktreeRecord {
  if (!record || (record.removedAt !== undefined && !record.snapshotRef)) {
    throw new Error(`worktree ${id} is not restorable`);
  }
  return record;
}

type RestoreInput = {
  id: string;
  recoverExactState?: ExactStateRetirement;
} & WorktreeAllocationGuard;
type RestoreDependencies = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  getConfig?: () => OpenClawConfig;
  admitCapacity: () => Promise<void>;
};
type RestoreContext = Omit<RestoreDependencies, "admitCapacity"> & {
  repository: ResolvedRepository;
  admitCapacity: (requiredPaths: readonly string[], alreadyCounted: boolean) => Promise<void>;
  requireSpace: (target: string, repository: ResolvedRepository, bytes?: number) => Promise<void>;
  recoveryClaim?: string;
};

async function restoreSnapshotProjection(
  worktree: ManagedWorktreeRecord,
  env: NodeJS.ProcessEnv,
  assertCurrent: WorktreeAllocationGuard["commitGuard"],
  workerAuthority: WorktreeAllocationGuard["workerAuthority"],
) {
  const { withSettledLocalWorkspace } =
    await import("../../gateway/worker-environments/local-workspace-projection.js");
  await withSettledLocalWorkspace(
    { worktree, env, assertCurrent, workerAuthority, restoreSnapshot: true },
    async () => {},
  );
}

/** Restore retains its canonical source and borrowed Git objects through native settlement. */
export async function restoreManagedWorktreeSnapshot(
  input: RestoreInput,
  dependencies: RestoreDependencies,
): Promise<ManagedWorktreeRecord> {
  const { env } = dependencies;
  // Queued removal can rebind the record before these allocation and checkout leases admit us.
  const preparedRecord = requireManagedWorktreeRestoreRecord(
    input.id,
    await readRegistryWorktreeForMutation({ ...input, env }),
  );
  if (!(await worktreePathExists(preparedRecord.repoRoot))) {
    throw new Error(`source repository no longer exists: ${preparedRecord.repoRoot}`);
  }
  const repository = await resolveRepository(preparedRecord.repoRoot);
  return await withWorktreeSources(
    {
      ...input,
      env,
      repository,
      requiredPaths: [preparedRecord.path],
      restoringId: preparedRecord.id,
    },
    async (retainSources) => {
      const context: RestoreContext = {
        env,
        now: dependencies.now,
        getConfig: dependencies.getConfig,
        repository,
        admitCapacity: async (requiredPaths, alreadyCounted) => {
          await retainSources(requiredPaths);
          if (!alreadyCounted) {
            await dependencies.admitCapacity();
          }
        },
        requireSpace: (target, sourceRepository, bytes) =>
          requireAllocationSpace(input, env, target, sourceRepository, bytes),
      };
      // An unfinished retirement still has a live row: retain its removal claim during recovery.
      const record = requireManagedWorktreeRestoreRecord(
        input.id,
        getRegistryWorktree(context.env, input.id),
      );
      if (!input.recoverExactState || record.removedAt !== undefined) {
        return await restoreSnapshot(input, context);
      }
      const expected = exactStateRetirementSchema.parse(input.recoverExactState);
      const assertOwner = () => {
        input.signal?.throwIfAborted();
        input.commitGuard?.();
        assertExactStateOwner(requireLiveSnapshotRecord(context.env, record.id), expected);
      };
      const token = randomUUID();
      const assertClaim = createWorktreeRemovalClaimsGuard(context.env, [record.id], token);
      await claimWorktreeRemoval(context.env, {
        worktreeId: record.id,
        token,
        assertCurrent: assertOwner,
        workerAuthority: {
          ...input.workerAuthority,
          predicates: [
            ...(input.workerAuthority.predicates ?? []),
            { kind: "exact-owner", record },
          ],
        },
      });
      try {
        return await restoreSnapshot(
          {
            ...input,
            workerAuthority: {
              ...input.workerAuthority,
              predicates: [
                ...(input.workerAuthority.predicates ?? []),
                { kind: "removal-claim", id: record.id, token },
              ],
            },
            commitGuard: () => {
              input.commitGuard?.();
              assertClaim();
            },
          },
          { ...context, recoveryClaim: token },
        );
      } finally {
        await abortWorktreeRemoval(context.env, record.id, token);
      }
    },
  );
}

/** Capture and restoration share the same versioned snapshot and native retention owner. */
async function restoreSnapshot(
  input: RestoreInput,
  context: RestoreContext,
): Promise<ManagedWorktreeRecord> {
  const { env, now, getConfig, requireSpace, repository } = context;
  let params = input;
  let finalized = false;
  const onFinalized = () => {
    finalized = true;
  };
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  let record = requireManagedWorktreeRestoreRecord(params.id, getRegistryWorktree(env, params.id));
  let capacityAdmitted = record.removedAt === undefined;
  if (record?.snapshotRef?.startsWith("refs/openclaw/snapshots/exact-")) {
    const original = record;
    const callerGuard = params.commitGuard;
    params = {
      ...params,
      workerAuthority: {
        ...params.workerAuthority,
        predicates: [
          ...(params.workerAuthority?.predicates ?? []),
          { kind: "exact-snapshot", record: original },
        ],
      },
      commitGuard: () => {
        callerGuard?.();
        if (finalized) {
          return;
        }
        assertExactSnapshotRecordCurrent(env, original);
      },
    };
  }
  if (
    !params.recoverExactState &&
    record?.snapshotRef?.startsWith("refs/openclaw/snapshots/exact-v1/") &&
    record.removedAt === undefined
  ) {
    const live = record;
    const options = { signal: params.signal, beforeRun: params.commitGuard };
    const pending = await runGit(
      live.repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/openclaw/removals/${live.id}`],
      options,
    );
    if (pending.code === 0) {
      throw new Error(
        "Exact retirement recovery is unfinished; retry restore with the original recover-exact-state request",
      );
    }
    if (pending.code !== 1) {
      throw commandError("git show-ref exact recovery", pending);
    }
    await requireExactWorktreeRepository(live, live.path, options);
    const receipt = await readExactRestoreReceipt(live, options);
    if (receipt) {
      if (
        receipt.snapshot !==
        (await requireGit(live.repoRoot, ["rev-parse", live.snapshotRef + "^{commit}"], options))
      ) {
        throw new Error("Completed exact restore snapshot changed; source and receipt preserved");
      }
      const assertCurrent = () => {
        params.commitGuard?.();
        assertExactStateSourceIdentity(live.path, receipt);
      };
      assertCurrent();
      await clearExactRestoreReceipt(live, receipt, { ...options, beforeRun: assertCurrent });
    }
    // Exact restore publishes this live row only after all recovery cleanup.
    // A lost acknowledgement after receipt deletion is therefore a completed retry.
    params.commitGuard?.();
    return live;
  }
  if (record?.snapshotRef && params.recoverExactState) {
    const expected = exactStateRetirementSchema.parse(params.recoverExactState);
    assertExactStateOwner({ ...record, removedAt: undefined }, expected);
    if (record.removedAt === undefined) {
      // A matching original incarnation may already be back after an interrupted
      // recovery. The native restore owner below validates identity and registration.
      const pending = await runGit(
        record.repoRoot,
        ["rev-parse", "--verify", "--quiet", `refs/openclaw/removals/${record.id}^{commit}`],
        { signal: params.signal, beforeRun: params.commitGuard },
      );
      if (pending.code !== 0 && pending.code !== 1) {
        throw commandError("git rev-parse exact recovery", pending);
      }
      const captured = await requireGit(
        record.repoRoot,
        ["rev-parse", `${record.snapshotRef}^{commit}`],
        { signal: params.signal, beforeRun: params.commitGuard },
      );
      const exact = await readExactStateSnapshot(record.repoRoot, captured, record.snapshotRef, {
        signal: params.signal,
        beforeRun: params.commitGuard,
      });
      if (
        !exact ||
        (pending.code === 0 && pending.stdout.trim() !== captured) ||
        exact.head !== expected.head ||
        exact.branchHead !== expected.branchHead ||
        exact.indexSha256 !== expected.indexSha256
      ) {
        throw new Error("Incomplete retirement recovery does not match the exact-state request");
      }
      if (
        pending.code === 1 &&
        (!(await worktreePathExists(record.path)) ||
          !(await listGitWorktrees(record.repoRoot)).some((entry) => entry.path === record!.path))
      ) {
        throw new Error(
          "Incomplete exact-state recovery lacks its source and retirement marker; snapshot preserved",
        );
      }
      const quarantine = path.join(path.dirname(record.path), exact.retirementName);
      const retainedSource = await worktreePathExists(quarantine);
      const retainedRegistration = (await listGitWorktrees(record.repoRoot)).some(
        (entry) => entry.path === quarantine,
      );
      if (retainedSource !== retainedRegistration) {
        throw new Error("Incomplete exact-state retirement; source and snapshot preserved");
      }
      params.commitGuard?.();
      assertExactStateOwner(requireLiveSnapshotRecord(env, record.id), expected);
      // This is only a local restore plan. A failed recovery must not start an
      // expiration deadline or finalize an unfinished registry lifecycle.
      record = { ...record, removedAt: now() };
    }
  }
  if (!record?.snapshotRef || record.removedAt === undefined) {
    throw new Error(`worktree ${params.id} is not restorable`);
  }
  const admitCapacity = async (requiredPaths: readonly string[]) => {
    // Incomplete retirement recovery can still own a live row already counted
    // by admission. Only removed records need another fleet slot.
    await context.admitCapacity(requiredPaths, capacityAdmitted);
    params.commitGuard?.();
    capacityAdmitted = true;
  };
  await requireSpace(record.path, repository);
  const provisionedState = await getRegistryWorktreeProvisionedState(env, record.id);
  params.commitGuard?.();
  if (provisionedState === undefined) {
    throw new Error(`worktree ${record.id} snapshot lacks provisioned file metadata`);
  }
  const provisionedBytes = provisionedState.reduce(
    (sum, entry) => sum + entry.chunks * SNAPSHOT_CHUNK_BYTES,
    0,
  );
  const gitOptions = {
    signal: params.signal,
    beforeRun: params.commitGuard,
    killProcessTree: true,
  };
  const snapshot = await requireGit(
    record.repoRoot,
    ["rev-parse", "--verify", `${record.snapshotRef}^{commit}`],
    gitOptions,
  );
  const exact = await readExactStateSnapshot(
    record.repoRoot,
    snapshot,
    record.snapshotRef,
    gitOptions,
  );
  if (
    exact &&
    (exact.branch !== record.branch ||
      (await requireGit(
        record.repoRoot,
        ["rev-parse", `refs/heads/${record.branch}^{commit}`],
        gitOptions,
      )) !== exact.branchHead)
  ) {
    throw new Error("Recorded branch changed after exact-state retirement; snapshot preserved");
  }
  if (exact) {
    const restoreRecord = record;
    const finalize = async (identity: ExactStateSnapshot) => {
      const callerGuard = params.commitGuard;
      const workerAuthority = params.workerAuthority;
      params = {
        ...params,
        workerAuthority: {
          ...workerAuthority,
          assertCurrent: () => {
            workerAuthority.assertCurrent?.();
            assertExactStateSourceIdentity(restoreRecord.path, identity);
          },
        },
        commitGuard: () => {
          callerGuard?.();
          assertExactStateSourceIdentity(restoreRecord.path, identity);
        },
      };
      await restoreSnapshotProjection(
        restoreRecord,
        env,
        params.commitGuard,
        params.workerAuthority,
      );
      return await finishRestoredSnapshot(
        params,
        context,
        restoreRecord,
        provisionedState.map((entry) => entry.path),
        onFinalized,
        true,
      );
    };
    if (!(await readExactRestoreReceipt(restoreRecord, gitOptions))) {
      const restored = await restoreRetiredExactWorktree({
        record: restoreRecord,
        metadata: exact,
        options: gitOptions,
        assertCurrent: () => params.commitGuard?.(),
        admitCapacity,
        finalize: () => finalize(exact),
      });
      if (restored) {
        return restored;
      }
    }
    const { targetBytes } = await estimateWorktreeCheckoutTransitionBytes(
      record.repoRoot,
      exact.head,
      snapshot,
      {
        signal: params.signal,
        assertCurrent: params.commitGuard,
      },
    );
    return await restoreExactSnapshotFallback({
      record: restoreRecord,
      snapshot,
      metadata: exact,
      env,
      states: provisionedState,
      options: gitOptions,
      assertCurrent: () => params.commitGuard?.(),
      admitCapacity,
      finalize,
      add: async (assertCurrent) => {
        const added = await addManagedWorktree({
          env,
          sourceOnly: true,
          now,
          enabled: false,
          repoRoot: restoreRecord.repoRoot,
          commonDir: repository.commonDir,
          worktreeRoot: path.dirname(path.dirname(restoreRecord.path)),
          destination: restoreRecord.path,
          base: exact.head,
          deferGitCheckout: true,
          requireSpace: () =>
            requireSpace(restoreRecord.path, repository, 2 * targetBytes + 2 * provisionedBytes),
          signal: params.signal,
          commitGuard: assertCurrent,
          rollbackGuard: params.rollbackGuard,
        });
        if (added.code !== 0) {
          throw commandError("git worktree add", added);
        }
      },
    });
  }
  let parent: string;
  try {
    parent = await requireGit(record.repoRoot, ["rev-parse", `${snapshot}^`], gitOptions);
  } catch (error) {
    const shallow = await runGit(
      record.repoRoot,
      ["rev-parse", "--is-shallow-repository"],
      gitOptions,
    );
    if (shallow.code !== 0 || shallow.stdout.trim() !== "true") {
      throw error;
    }
    // Origin cannot deepen a local-only snapshot that a later fetch made shallow.
    throw new Error(
      `Cannot restore snapshot ${snapshot} in ${record.repoRoot}: shallow clone boundary; run \`git fetch --unshallow\` in ${record.repoRoot}. If the snapshot remains shallow, recover its parent from the original repository before retrying.`,
      { cause: error },
    );
  }
  const { targetBytes, changedBytes, requiresFullCheckout } =
    await estimateWorktreeCheckoutTransitionBytes(record.repoRoot, parent, snapshot, {
      signal: params.signal,
      assertCurrent: params.commitGuard,
    });
  const target = await lstatIfExists(record.path);
  const registrations = await listGitWorktrees(record.repoRoot, gitOptions);
  if (
    (target && (!target.isDirectory() || (await fs.readdir(record.path)).length > 0)) ||
    registrations.some(
      (entry) => entry.path === record.path || entry.branch === `refs/heads/${record.branch}`,
    )
  ) {
    throw new Error(
      "Worktree restore destination or branch is occupied; existing checkouts preserved",
    );
  }
  let branch: Parameters<typeof addManagedWorktree>[0]["branch"] = record.branch || undefined;
  if (record.branch) {
    const ref = `refs/heads/${record.branch}`;
    const retained = await runGit(
      record.repoRoot,
      ["show-ref", "--quiet", "--verify", ref],
      gitOptions,
    );
    if (retained.code === 0) {
      if (
        (await requireGit(
          record.repoRoot,
          ["rev-parse", "--verify", `${ref}^{commit}`],
          gitOptions,
        )) !== parent
      ) {
        throw new Error(
          "Recorded branch moved after worktree removal; branch and existing checkouts preserved",
        );
      }
      branch = { mode: "existing", name: record.branch };
    } else if (retained.code !== 1) {
      throw commandError("git show-ref retained worktree branch", retained);
    }
  }
  const sourceOnly = await usesSourceOnlyWorktreeGit(record, env, getConfig ?? getRuntimeConfig);
  await admitCapacity([record.repoRoot, record.path]);
  params.commitGuard?.();
  await fs.mkdir(path.dirname(record.path), { recursive: true });
  params.commitGuard?.();
  const added = await addManagedWorktree({
    env,
    sourceOnly,
    now,
    enabled: getConfig?.().worktreeAcceleration !== false,
    repoRoot: record.repoRoot,
    commonDir: repository.commonDir,
    worktreeRoot: path.dirname(path.dirname(record.path)),
    destination: record.path,
    base: parent,
    branch,
    deferGitCheckout: true,
    requireSpace: (cloneBytes) =>
      requireSpace(
        record.path,
        repository,
        (cloneBytes === undefined ? 2 * targetBytes : cloneBytes + 2 * changedBytes) +
          2 * provisionedBytes,
      ),
    signal: params.signal,
    commitGuard: () => params.commitGuard?.(),
    rollbackGuard: params.rollbackGuard,
  });
  if (added.code !== 0) {
    throw commandError("git worktree add", added);
  }
  let restoredProvisionedPaths: string[];
  try {
    // Reuse the original source template. Git replaces only snapshot differences,
    // then resets the index so saved additions are untracked and edits unstaged.
    // The synthetic snapshot never becomes the branch's HEAD or a cached template.
    const materializationBytes = added.templateCloned ? changedBytes : targetBytes;
    const checkoutOptions = {
      ...gitOptions,
      startRun: async <T>(run: () => T): Promise<Awaited<T>> => {
        params.commitGuard?.();
        await requireSpace(
          record.path,
          repository,
          2 * materializationBytes + 2 * provisionedBytes,
        );
        params.commitGuard?.();
        return await run();
      },
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    };
    const materialized = await materializeManagedWorktree(
      {
        destination: record.path,
        commit: snapshot,
        sourceOnly,
        resetIndexTo: parent,
        removeExisting: requiresFullCheckout && added.templateCloned === true,
      },
      checkoutOptions,
      gitOptions,
    );
    if (materialized.code !== 0) {
      throw commandError("git read-tree", materialized);
    }

    params.commitGuard?.();
    await requireSpace(record.path, repository, 2 * provisionedBytes);
    await restoreProvisionedFiles(
      env,
      record.id,
      record.path,
      provisionedState,
      params.commitGuard,
    );
    params.commitGuard?.();
    await restoreSnapshotProjection(record, env, params.commitGuard, params.workerAuthority);
    await requireSpace(record.path, repository);
    restoredProvisionedPaths = provisionedState.map((state) => state.path);
  } catch (error) {
    const failure = await removeFailedWorktree(
      record.repoRoot,
      record.path,
      typeof branch === "string" ? branch : undefined,
      params.rollbackGuard,
    );
    if (failure) {
      throw new Error(`${String(error)}\nrestore cleanup failed: ${failure.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  return await finishRestoredSnapshot(
    params,
    context,
    record,
    restoredProvisionedPaths,
    onFinalized,
  );
}

async function finishRestoredSnapshot(
  params: { id: string } & WorktreeAllocationGuard,
  context: Pick<RestoreContext, "env" | "now" | "recoveryClaim">,
  record: ManagedWorktreeRecord,
  restoredProvisionedPaths: string[],
  onFinalized: () => void,
  exact = false,
) {
  const { env, now } = context;
  const gitOptions = {
    signal: params.signal,
    beforeRun: params.commitGuard,
    killProcessTree: true,
  };
  params.commitGuard?.();
  // Advance past the stored stamp even within the same millisecond: stale
  // cleanup writes fence on the activity stamp they observed, so a restore
  // must never revive the row with an identical value.
  const lastActiveAt = Math.max(now(), record.lastActiveAt + 1);
  const restored = { ...record, lastActiveAt };
  delete restored.removedAt;
  delete restored.runEndCleanup;
  const finishRecovery = async () => {
    params.commitGuard?.();
    await requireGit(
      record.repoRoot,
      ["update-ref", "-d", `refs/openclaw/removals/${record.id}`],
      gitOptions,
    );
    const { withSettledLocalWorkspace } =
      await import("../../gateway/worker-environments/local-workspace-projection.js");
    await withSettledLocalWorkspace(
      {
        worktree: restored,
        env,
        assertCurrent: params.commitGuard,
        workerAuthority: params.workerAuthority,
        finishRestore: true,
      },
      async () => {},
    );
  };
  // Settle old leases while the row still refuses new runs. Revival must not race this await.
  if (!context.recoveryClaim) {
    await finalizeWorktreeRemoval(
      env,
      { worktreeId: params.id, lastActiveAt: record.lastActiveAt, removedAt: record.removedAt },
      params.workerAuthority,
    );
  }
  // Exact recovery keeps the row removed until every idempotent cleanup step
  // completes. A live-row retry must never delete leases from a newly admitted run.
  if (exact) {
    await finishRecovery();
  }
  await updateRegistryWorktree(
    env,
    params.id,
    {
      removedAt: undefined,
      lastActiveAt,
      provisionedPaths: restoredProvisionedPaths,
      // The recorded cleanup outcome described the removed lifecycle; a restored
      // checkout starts a new one, so a stale removed-lossless must not show on
      // a live row until the next run-end cleanup records fresh truth.
      runEndCleanup: undefined,
    },
    { assertCurrent: params.commitGuard, workerAuthority: params.workerAuthority },
  );
  onFinalized();
  if (!exact) {
    await finishRecovery();
  }
  return restored;
}
