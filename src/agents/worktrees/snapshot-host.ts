import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { requireWorktreeDiskSpace } from "./capacity.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { removeUnusedEmptyWorktreeSource } from "./empty-source.js";
import { requireGit, worktreePathExists, commandError, listGitWorktrees, runGit } from "./git.js";
import { snapshotProvisionedFiles } from "./provisioned-files.js";
import {
  deleteRegistryWorktree,
  assertRegistrySnapshotRetirement,
  assertWorktreeRemovalClaim,
  getRegistryWorktree,
} from "./registry.js";
import { assertExactStateSourceIdentity } from "./removal-git.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import { resolveRepository } from "./service-preparation.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import { readExactStateSnapshot } from "./snapshot-exact-state.js";
import { clearExactRestoreReceipt, readExactRestoreReceipt } from "./snapshot-restore-exact.js";
import type { ManagedWorktreeRecord, RetireManagedWorktreeSnapshotParams } from "./types.js";

/** Existing snapshot worker and effect owners, supplied with this operation's Git policy. */
export async function captureManagedWorktreeSnapshot(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  reason: string;
  provisionedPaths: readonly string[];
  exactState?: ExactStateRetirement;
  retirementName?: string;
  git: WorktreeGitPolicy;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const { record, env, provisionedPaths } = params;
  const exactState =
    params.exactState && params.retirementName
      ? {
          branch: record.branch,
          expected: params.exactState,
          retirementName: params.retirementName,
        }
      : undefined;
  if (params.exactState && !exactState) {
    throw new Error("Exact-state capture lacks retirement custody");
  }
  return await runGitWorkerOperation(
    {
      type: "worktree.snapshot",
      input: {
        worktreeId: record.id,
        checkoutPath: record.path,
        repoRoot: record.repoRoot,
        reason: params.reason,
        provisionedPaths,
        ...(exactState ? { exactState } : {}),
      },
    },
    {
      signal: params.signal,
      assertCurrent: params.assertCurrent,
      git: params.git.worker,
      onEffect: async (effect, { signal }) => {
        const assertCurrent = () => {
          signal.throwIfAborted();
          params.assertCurrent?.();
        };
        assertCurrent();
        switch (effect.type) {
          case "worktree.assert-current":
            return undefined;
          case "worktree.snapshot-capacity":
            requireWorktreeDiskSpace(
              [
                ...effect.input.demands,
                ...(effect.input.stateBytes === undefined
                  ? []
                  : [{ path: resolveStateDir(env), bytes: effect.input.stateBytes }]),
              ],
              effect.input.purpose,
              true,
            );
            return undefined;
          case "worktree.snapshot-provisioned":
            return await snapshotProvisionedFiles(env, record.id, record.path, provisionedPaths, {
              signal,
              assertCurrent,
              expected: effect.input.expected,
            });
        }
        return undefined;
      },
    },
  );
}

export async function verifyManagedWorktreeExactSnapshot(params: {
  record: ManagedWorktreeRecord;
  expected: ExactStateRetirement;
  expectedDigest: string;
  retirementName: string;
  provisionedPaths: readonly string[];
  git: WorktreeGitPolicy;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  await runGitWorkerOperation(
    {
      type: "worktree.snapshot-verify-exact",
      input: {
        worktreeId: params.record.id,
        checkoutPath: params.record.path,
        repoRoot: params.record.repoRoot,
        reason: "exact-state verification",
        provisionedPaths: params.provisionedPaths,
        exactState: {
          branch: params.record.branch,
          expected: params.expected,
          retirementName: params.retirementName,
        },
        expectedDigest: params.expectedDigest,
      },
    },
    {
      signal: params.signal,
      assertCurrent: params.assertCurrent,
      git: params.git.worker,
      onEffect: async () => {
        params.signal?.throwIfAborted();
        params.assertCurrent();
        return undefined;
      },
    },
  );
}

export function assertExactSnapshotRecordCurrent(
  env: NodeJS.ProcessEnv,
  original: ManagedWorktreeRecord,
) {
  const current = getRegistryWorktree(env, original.id);
  if (
    !current ||
    current.ownerKind !== original.ownerKind ||
    current.ownerId !== original.ownerId ||
    current.createdAt !== original.createdAt ||
    current.lastActiveAt !== original.lastActiveAt ||
    current.removedAt !== original.removedAt ||
    current.path !== original.path ||
    current.repoRoot !== original.repoRoot ||
    current.repoFingerprint !== original.repoFingerprint ||
    current.branch !== original.branch ||
    current.snapshotRef !== original.snapshotRef
  ) {
    throw new Error(
      "Exact-state recovery owner or lifecycle changed; source and snapshot preserved",
    );
  }
}

/** Local CLI retirement shares the same allocation owner as removal and GC. */
export async function retireManagedWorktreeSnapshotById(
  params: RetireManagedWorktreeSnapshotParams,
  env: NodeJS.ProcessEnv = process.env,
) {
  return await withWorktreeAllocationLease({ ...params, env }, async (guard) => {
    const record = getRegistryWorktree(env, params.id);
    if (
      !record ||
      record.removedAt === undefined ||
      record.removedAt !== params.expectedRemovedAt ||
      record.snapshotRef !== params.expectedSnapshotRef
    ) {
      throw new Error("Expected removed worktree snapshot identity does not match");
    }
    await retireManagedWorktreeSnapshot({
      record,
      env,
      signal: guard.signal,
      assertCurrent: () => guard.commitGuard(),
      expected: params,
    });
    return { retired: true as const, id: record.id };
  });
}

/** Preparation remains under the allocation owner; Git commits exact ref custody atomically. */
async function prepareExactSnapshotRetirement(params: {
  record: ManagedWorktreeRecord;
  expected: RetireManagedWorktreeSnapshotParams;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  const { record, expected, signal, assertCurrent } = params;
  const ref = `refs/openclaw/snapshots/${record.id}`;
  if (
    expected.id !== record.id ||
    expected.expectedSnapshotRef !== ref ||
    record.snapshotRef !== ref ||
    record.removedAt !== expected.expectedRemovedAt ||
    !Number.isSafeInteger(expected.expectedRemovedAt) ||
    expected.expectedRemovedAt < 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expected.expectedSnapshotOid) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expected.expectedRetainedSourceOid) ||
    !/^refs\/(?:heads|remotes)\//u.test(expected.retainedSourceRef)
  ) {
    throw new Error("Invalid exact snapshot retirement identity or retained source ref");
  }
  const options = {
    signal,
    beforeRun: assertCurrent,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  };
  await requireGit(record.repoRoot, ["check-ref-format", ref], options);
  await requireGit(record.repoRoot, ["check-ref-format", expected.retainedSourceRef], options);
  const repository = await resolveRepository(record.repoRoot);
  assertCurrent();
  if (
    repository.repoRoot !== record.repoRoot ||
    repository.fingerprint !== record.repoFingerprint
  ) {
    throw new Error("Worktree snapshot repository identity changed");
  }
  if (
    (await worktreePathExists(record.path)) ||
    (await listGitWorktrees(record.repoRoot, options)).some(
      (entry) => path.resolve(entry.path) === path.resolve(record.path),
    )
  ) {
    throw new Error("Worktree snapshot still has a checkout or Git registration");
  }
  for (const [reference, oid] of [
    [ref, expected.expectedSnapshotOid],
    [expected.retainedSourceRef, expected.expectedRetainedSourceOid],
  ] as const) {
    const symbolic = await runGit(record.repoRoot, ["symbolic-ref", "--quiet", reference], options);
    if (symbolic.code !== 1) {
      throw new Error("Snapshot retirement requires direct, not symbolic, refs");
    }
    if (
      (await requireGit(
        record.repoRoot,
        ["show-ref", "--verify", "--hash", reference],
        options,
      )) !== oid
    ) {
      throw new Error("Snapshot retirement ref OID changed");
    }
  }
  const pendingRef = `refs/openclaw/removals/${record.id}`;
  const pending = await runGit(
    record.repoRoot,
    ["show-ref", "--verify", "--quiet", pendingRef],
    options,
  );
  if (pending.code !== 1) {
    throw new Error("Snapshot retirement has pending removal custody");
  }
  const snapshotTree = await requireGit(
    record.repoRoot,
    ["rev-parse", `${expected.expectedSnapshotOid}^{tree}`],
    options,
  );
  const retainedTree = await requireGit(
    record.repoRoot,
    ["rev-parse", `${expected.expectedRetainedSourceOid}^{tree}`],
    options,
  );
  if (snapshotTree !== retainedTree) {
    throw new Error("Snapshot contains source not covered by the retained commit");
  }
  const parents = (
    await requireGit(
      record.repoRoot,
      ["rev-list", "--parents", "-n", "1", expected.expectedSnapshotOid],
      options,
    )
  ).split(" ");
  if (parents.length !== 2) {
    throw new Error("Snapshot parent custody is unavailable");
  }
  await requireGit(
    record.repoRoot,
    ["merge-base", "--is-ancestor", parents[1]!, expected.expectedRetainedSourceOid],
    options,
  );
  assertCurrent();
  return async (assertProjectionCurrent: () => void) => {
    const beforeRun = () => {
      assertCurrent();
      assertProjectionCurrent();
    };
    if (
      (await worktreePathExists(record.path)) ||
      (await listGitWorktrees(record.repoRoot, { ...options, beforeRun })).some(
        (entry) => path.resolve(entry.path) === path.resolve(record.path),
      )
    ) {
      throw new Error("Worktree snapshot checkout or Git registration reappeared");
    }
    // One transaction verifies the retained source and absent removal pin while
    // deleting only the observed snapshot. Verification must lock the retained
    // ref chain; no-deref is scoped to the pending pin and snapshot deletion.
    await requireGit(record.repoRoot, ["update-ref", "--stdin"], {
      ...options,
      beforeRun,
      input: `start\nverify ${expected.retainedSourceRef} ${expected.expectedRetainedSourceOid}\noption no-deref\nverify ${pendingRef} ${"0".repeat(expected.expectedSnapshotOid.length)}\noption no-deref\ndelete ${ref} ${expected.expectedSnapshotOid}\nprepare\ncommit\n`,
    });
  };
}

/** Retire the restore entry point before releasing accepted projection custody. */
export async function retireManagedWorktreeSnapshot(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
  expected?: RetireManagedWorktreeSnapshotParams;
}) {
  const { record, env, signal } = params;
  if (params.expected) {
    const { localWorkspaceStore } =
      await import("../../gateway/worker-environments/local-workspace-store.js");
    const projectionStore = localWorkspaceStore(env);
    const assertCurrent = () => {
      params.assertCurrent();
      assertRegistrySnapshotRetirement(env, record);
      if (projectionStore.get(record.id)) {
        throw new Error(
          "Snapshot retains local workspace projection custody; preserve its recovery data",
        );
      }
    };
    assertCurrent();
    const retireSnapshot = await prepareExactSnapshotRetirement({
      record,
      expected: params.expected,
      signal,
      assertCurrent,
    });
    const { expireLocalWorkspaceProjection } =
      await import("../../gateway/worker-environments/local-workspace-projection.js");
    await expireLocalWorkspaceProjection({ worktree: record, env, assertCurrent, retireSnapshot });
    assertCurrent();
    deleteRegistryWorktree(env, record.id, { assertCurrent, expectedRetired: record });
    // Retained source refs remain owned, including an otherwise empty source repository.
    return;
  }
  const exactRecord = record.snapshotRef?.startsWith("refs/openclaw/snapshots/exact-");
  const expirationToken = exactRecord ? randomUUID() : undefined;
  let claimed = false;
  const assertCurrent = () => {
    params.assertCurrent();
    if (exactRecord) {
      assertExactSnapshotRecordCurrent(env, record);
      if (claimed && expirationToken) {
        assertWorktreeRemovalClaim(env, record.id, expirationToken);
      }
    }
  };
  if (exactRecord && !(await worktreePathExists(record.repoRoot))) {
    throw new Error("Exact-state source repository unavailable; recovery and registry preserved");
  }
  if (expirationToken) {
    claimWorktreeRemoval(env, {
      worktreeId: record.id,
      token: expirationToken,
      retiredExact: true,
      assertCurrent,
    });
    claimed = true;
  }
  try {
    const { expireLocalWorkspaceProjection } =
      await import("../../gateway/worker-environments/local-workspace-projection.js");
    await expireLocalWorkspaceProjection({
      worktree: record,
      env,
      assertCurrent,
      retireSnapshot: async (assertProjectionCurrent) => {
        const beforeRun = () => {
          assertCurrent();
          assertProjectionCurrent();
        };
        if (await worktreePathExists(record.repoRoot)) {
          if (record.snapshotRef) {
            const found = await runGit(
              record.repoRoot,
              ["rev-parse", "--verify", "--quiet", record.snapshotRef + "^{commit}"],
              { signal, beforeRun },
            );
            if (found.code !== 0 && found.code !== 1) {
              throw commandError("git rev-parse snapshot", found);
            }
            const snapshot = found.code === 0 ? found.stdout.trim() : undefined;
            const exact = snapshot
              ? await readExactStateSnapshot(record.repoRoot, snapshot, record.snapshotRef, {
                  signal,
                  beforeRun,
                })
              : undefined;
            const assertNoLiveSource = () => {
              beforeRun();
              if (lstatSync(record.path, { throwIfNoEntry: false })) {
                throw new Error(
                  "Exact-state source already moved back; source and snapshot preserved",
                );
              }
            };
            const registrations = exactRecord ? await listGitWorktrees(record.repoRoot) : [];
            if (exactRecord) {
              assertNoLiveSource();
              if (registrations.some((entry) => entry.path === record.path)) {
                throw new Error(
                  "Exact-state live registration remains; source and snapshot preserved",
                );
              }
              if (
                !snapshot &&
                !record.snapshotRef.startsWith("refs/openclaw/snapshots/exact-v1/")
              ) {
                throw new Error("Unsupported exact-state snapshot version; registry preserved");
              }
            }
            if (exact) {
              const retained = path.join(path.dirname(record.path), exact.retirementName);
              const exists = await worktreePathExists(retained);
              const registered = registrations.some((entry) => entry.path === retained);
              if (exists !== registered) {
                throw new Error(
                  "Exact-state retention source is incomplete; source and snapshot preserved",
                );
              }
              if (registered) {
                // This is expiration after the normal recovery deadline, never the
                // retirement operation. Keep the snapshot if native cleanup fails.
                await requireGit(
                  record.repoRoot,
                  ["worktree", "remove", "--force", "--", retained],
                  {
                    beforeRun: () => {
                      assertNoLiveSource();
                      assertExactStateSourceIdentity(retained, exact);
                    },
                    killProcessTree: true,
                  },
                );
              }
            }
            // Missing metadata can mean a prior expiry already deleted the ref.
            // Finalize the expired row idempotently, but never infer or delete an
            // unknown retained directory without its captured identity.
            await requireGit(
              record.repoRoot,
              ["update-ref", "-d", record.snapshotRef, ...(snapshot ? [snapshot] : [])],
              {
                signal,
                beforeRun: exactRecord ? assertNoLiveSource : beforeRun,
              },
            );
            if (exactRecord) {
              const receipt = await readExactRestoreReceipt(record, {
                signal,
                beforeRun: assertNoLiveSource,
              });
              if (receipt) {
                await clearExactRestoreReceipt(record, receipt, {
                  signal,
                  beforeRun: assertNoLiveSource,
                });
              }
            }
          }
          // Snapshot-loss removal can leave only a pending HEAD pin. Keep its
          // registry owner until that pin has been cleared too.
          await requireGit(
            record.repoRoot,
            ["update-ref", "-d", "refs/openclaw/removals/" + record.id],
            { signal, beforeRun },
          );
        }
      },
    });
    await removeUnusedEmptyWorktreeSource({ env, record, signal, commitGuard: assertCurrent });
    assertCurrent();
    deleteRegistryWorktree(env, record.id, { assertCurrent, removalToken: expirationToken });
  } finally {
    if (expirationToken && claimed) {
      abortWorktreeRemoval(env, record.id, expirationToken);
    }
  }
}
