import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation, type GitWorkerOperationOptions } from "../../infra/git-worker.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { releaseOpenClawStateLeaseBestEffort } from "../../state/openclaw-state-lease-storage.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { WORKTREE_CAPACITY_RESERVATION_SCOPE } from "./capacity-contract.js";
import { reserveWorktreeCapacity, releaseWorktreeCapacity } from "./capacity-store.js";
import type { GitWorktreeOperations } from "./git-worktree-operations.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { ResolvedRepository } from "./service-preparation.js";
import type { WorktreeLeaseSet, WorktreeWorkerAuthority } from "./types.js";

export { WORKTREE_CAPACITY_RESERVATION_SCOPE } from "./capacity-contract.js";
export const WORKTREE_SETUP_HEADROOM_BYTES = 4 * 1024 ** 3;

type CapacityRelease = { context: OpenClawStateWorkerContext; retry: () => Promise<void> };
const pendingCapacityReleases = new Set<CapacityRelease>();

/** Failed exact-token releases stay owned until a later admission or maintenance pass succeeds. */
export async function retryWorktreeCapacityReleases(env: NodeJS.ProcessEnv): Promise<unknown[]> {
  if (pendingCapacityReleases.size === 0) {
    return [];
  }
  const failures: unknown[] = [];
  const current = captureOpenClawStateWorkerContext({ env }).admission;
  for (const cleanup of pendingCapacityReleases) {
    const original = cleanup.context.admission;
    if (
      original.databasePath !== current.databasePath ||
      original.identity.key !== current.identity.key
    ) {
      continue;
    }
    try {
      await cleanup.retry();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export class WorktreeCapacityContentionError extends Error {
  constructor(
    message: string,
    readonly reservationKey: string,
  ) {
    super(message);
    this.name = "WorktreeCapacityContentionError";
  }
}

export async function requireAllocationSpace(
  guard: Pick<WorktreeAllocationGuard, "requireDiskSpace">,
  env: NodeJS.ProcessEnv,
  target: string,
  repository: Pick<ResolvedRepository, "commonDir" | "sourceRoot">,
  bytes = 0,
) {
  await guard.requireDiskSpace(
    [
      { path: target, bytes },
      { path: repository.commonDir, bytes: 0 },
      { path: repository.sourceRoot, bytes: 0 },
      { path: resolveStateDir(env), bytes: 0 },
    ],
    "worktree allocation",
  );
}

/** Byte debt survives lease expiry until its native work settles, like existing worktree run custody. */
export function createWorktreeDiskAdmission(params: {
  env: NodeJS.ProcessEnv;
  workerAuthority: WorktreeWorkerAuthority & { leaseSet: WorktreeLeaseSet };
  assertCurrent: () => void;
}) {
  const key = randomUUID();
  const context = captureWorktreeRunEndContext(params.env);
  const { leaseSet, assertCurrent: assertWorkerCurrent } = params.workerAuthority;
  const predicates = structuredClone(params.workerAuthority.predicates);
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(process.pid),
  };
  let reserved = false;
  let closed = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    closed = true;
    if (!reserved) {
      return Promise.resolve();
    }
    return (releasing ??= (async () => {
      try {
        await releaseOpenClawStateLeaseBestEffort(
          {
            scope: WORKTREE_CAPACITY_RESERVATION_SCOPE,
            key,
            owner: key,
            database: {
              scope: "shared",
              options: { path: context.admission.databasePath, env: context.environment },
            },
            leaseLabel: "managed worktree capacity reservation",
            operationLabel: "agents.worktrees.capacity-release",
          },
          () =>
            releaseWorktreeCapacity({
              context,
              key,
              assertCurrent: () => {
                if (!closed || !reserved) {
                  throw new Error("Managed worktree reservation cleanup is no longer owned");
                }
              },
            }),
        );
        reserved = false;
        pendingCapacityReleases.delete(cleanup);
      } catch (cause) {
        pendingCapacityReleases.add(cleanup);
        throw new Error(
          "Managed worktree disk reservation cleanup failed; capacity release is unconfirmed",
          { cause },
        );
      } finally {
        releasing = undefined;
      }
    })());
  };
  const cleanup: CapacityRelease = { context, retry: release };
  return {
    requireDiskSpace: async (
      demands: readonly { path: string; bytes: number }[],
      purpose: string,
      snapshot = false,
    ): Promise<void> => {
      if (closed) {
        throw new Error("Managed worktree disk admission has closed");
      }
      params.assertCurrent();
      if (pendingCapacityReleases.size > 0) {
        // Failed retries still count against admission; unrelated writes can use remaining space.
        await retryWorktreeCapacityReleases(params.env);
        params.assertCurrent();
      }
      reserved = true;
      const result = await reserveWorktreeCapacity({
        leaseSet,
        request: { key, owner, demands, purpose, snapshot },
        predicates,
        assertCurrent: () => {
          context.admission.assertCurrent();
          assertWorkerCurrent?.();
        },
      });
      params.assertCurrent();
      if (!result.admitted) {
        throw result.reservationKey
          ? new WorktreeCapacityContentionError(result.message, result.reservationKey)
          : new Error(result.message);
      }
    },
    release,
  };
}

export async function estimateWorktreeGitBytes(
  repoRoot: string,
  ref: string,
  options: Pick<GitWorkerOperationOptions, "signal" | "assertCurrent" | "git"> = {},
): Promise<number> {
  return await runGitWorkerOperation(
    {
      type: "worktree.git-size",
      input: {
        repoRoot,
        ref,
        replacementRefBase: process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/",
      },
    },
    options,
  );
}

/** Budget a full snapshot checkout or the destination blobs written over a source clone. */
export async function estimateWorktreeCheckoutTransitionBytes(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
  options: Pick<GitWorkerOperationOptions, "signal" | "assertCurrent"> = {},
): Promise<GitWorktreeOperations["worktree.checkout-transition-size"]["output"]> {
  return await runGitWorkerOperation(
    {
      type: "worktree.checkout-transition-size",
      input: {
        repoRoot,
        baseRef,
        targetRef,
        replacementRefBase: process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/",
      },
    },
    options,
  );
}

/** Each call measures current files; allocation cannot use a settled directory-size cache. */
export async function directorySizeBytes(
  root: string,
  excludeGit = false,
  options: Pick<GitWorkerOperationOptions, "signal" | "assertCurrent"> = {},
): Promise<number> {
  return await runGitWorkerOperation(
    { type: "worktree.directory-size", input: { root, excludeGit } },
    options,
  );
}
