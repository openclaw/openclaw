import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { requireWorktreeDiskSpace } from "./capacity.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { removeUnusedEmptyWorktreeSource } from "./empty-source.js";
import { requireGit, worktreePathExists, commandError, listGitWorktrees, runGit } from "./git.js";
import { snapshotProvisionedFiles } from "./provisioned-files.js";
import {
  deleteRegistryWorktree,
  assertWorktreeRemovalClaim,
  getRegistryWorktree,
} from "./registry.js";
import { assertExactStateSourceIdentity } from "./removal-git.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import { readExactStateSnapshot } from "./snapshot-exact-state.js";
import { clearExactRestoreReceipt, readExactRestoreReceipt } from "./snapshot-restore-exact.js";
import type { ManagedWorktreeRecord } from "./types.js";

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

/** Retire the restore entry point before releasing accepted projection custody. */
export async function retireManagedWorktreeSnapshot(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  const { record, env, signal } = params;
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
