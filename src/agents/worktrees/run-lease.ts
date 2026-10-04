import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueKeyedTask } from "../../plugin-sdk/keyed-async-queue.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { lockWorktreeForProcess, unlockWorktree } from "./git-lock.js";
import { worktreePathExists } from "./git.js";
import { readRegistryWorktree } from "./registry-read.js";
import {
  claimWorktreeRemovalRow,
  getRegistryWorktree,
  hasLiveWorktreeRunLeaseRow,
  listRegistryWorktrees,
  releaseWorktreeRunLeaseRow,
} from "./registry.js";
import {
  admitWorktreeRunLeaseRowAsync,
  releaseWorktreeRunLeaseRowAsync,
} from "./run-lease-store.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "./types.js";

export {
  abortWorktreeRemovalRow as abortWorktreeRemoval,
  finalizeWorktreeRemovalRows as finalizeWorktreeRemoval,
} from "./registry.js";

const log = createSubsystemLogger("agents/worktrees");

const RELEASE_MAX_ATTEMPTS = 3;

type WorktreeRunLease = {
  id: string;
  token: string;
  release: () => Promise<void>;
};

type HeldWorktreeLock = { refcount: number; gitLocked: boolean };

// The git lock is a per-process single-holder resource; a parent and a same-process
// child that share one worktree refcount it here so a child release does not unlock
// the parent's still-live checkout.
const heldGitLocks = new Map<string, HeldWorktreeLock>();
const gitLockTransitionTails = new Map<string, Promise<void>>();

// A cleanup that could not finish (persistent state-database delete or git unlock
// failure) is retained here for lifecycle retries. Unknown native admission stays
// fenced until process death permits stale-owner reaping; deletion could race a late insert.
type LeaseCleanup = {
  env: NodeJS.ProcessEnv;
  context: OpenClawStateWorkerContext;
  id: string;
  token: string;
  rowDeleted: boolean;
  admissionSettled: boolean;
  gitRetained: boolean;
  refcountReleased: boolean;
};
const pendingLeaseCleanups = new Set<LeaseCleanup>();
let exitCleanupRegistered = false;

function withGitLockTransition<T>(id: string, task: () => Promise<T>): Promise<T> {
  return enqueueKeyedTask({ tails: gitLockTransitionTails, key: id, task });
}

async function retainGitLock(context: OpenClawStateWorkerContext, id: string): Promise<void> {
  await withGitLockTransition(id, async () => {
    const held = heldGitLocks.get(id) ?? { refcount: 0, gitLocked: false };
    const needsLock = held.refcount === 0 && !held.gitLocked;
    held.refcount += 1;
    heldGitLocks.set(id, held);
    if (!needsLock) {
      return;
    }
    let record: ManagedWorktreeRecord | undefined;
    try {
      record = await readRegistryWorktree(context, id);
      if (!record) {
        return;
      }
      await lockWorktreeForProcess(record);
      held.gitLocked = true;
    } catch (error) {
      heldGitLocks.delete(id);
      throw new Error(
        `managed worktree is unusable because its Git removal guard could not be acquired: ${record?.path ?? id}; checkout preserved. Repair its Git metadata or create a new worktree before retrying: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  });
}

async function releaseGitLock(cleanup: LeaseCleanup): Promise<boolean> {
  return await withGitLockTransition(cleanup.id, async () => {
    const held = heldGitLocks.get(cleanup.id);
    if (!cleanup.refcountReleased) {
      cleanup.refcountReleased = true;
      if (held) {
        held.refcount -= 1;
      }
    }
    if (!held) {
      return true;
    }
    if (held.refcount > 0) {
      // A newer holder adopted a guard whose prior unlock failed. Its own final
      // release now owns the unlock; stale cleanup must not drop that generation.
      return true;
    }
    if (!held.gitLocked) {
      heldGitLocks.delete(cleanup.id);
      return true;
    }
    try {
      const record = await readRegistryWorktree(cleanup.context, cleanup.id);
      if (record) {
        await unlockWorktree(record);
      }
    } catch (error) {
      log.warn(`failed to unlock worktree ${cleanup.id}: ${errorMessage(error)}`);
      return false;
    }
    heldGitLocks.delete(cleanup.id);
    return true;
  });
}

async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export async function resolveWorktreeIdForPath(params: {
  sessionEntry?: { worktree?: { id: string } };
  candidatePaths: Array<string | undefined>;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const boundId = params.sessionEntry?.worktree?.id;
  if (boundId !== undefined) {
    // The session's stored binding is authoritative: if that worktree is gone the
    // run must fail closed rather than silently continue as an unmanaged directory.
    const record = getRegistryWorktree(env, boundId);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`managed worktree was removed: ${record?.path ?? boundId}`);
    }
    return boundId;
  }
  const records = listRegistryWorktrees(env).filter((record) => record.removedAt === undefined);
  if (records.length === 0) {
    return undefined;
  }
  const bases = new Map<string, string>();
  for (const record of records) {
    bases.set(record.id, await realpathOrSelf(record.path));
  }
  const seen = new Set<string>();
  for (const candidate of params.candidatePaths) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const real = await realpathOrSelf(candidate);
    for (const record of records) {
      const base = bases.get(record.id);
      if (base && (real === base || real.startsWith(`${base}${path.sep}`))) {
        return record.id;
      }
    }
  }
  return undefined;
}

async function deleteRunLeaseRowWithRetries(cleanup: LeaseCleanup): Promise<boolean> {
  for (let attempt = 1; attempt <= RELEASE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await releaseWorktreeRunLeaseRowAsync(
        cleanup.env,
        cleanup.id,
        cleanup.token,
        cleanup.context,
      );
      return true;
    } catch (error) {
      log.warn(
        `failed to release worktree run lease for ${cleanup.id} (attempt ${attempt}): ${errorMessage(error)}`,
      );
      if (attempt < RELEASE_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25 * attempt);
        });
      }
    }
  }
  return false;
}

// Drives a lease cleanup as far as it can and returns true only once both the token
// row and the git guard are released. Keeps everything until each step succeeds so a
// removal stays correctly blocked while cleanup is still owed.
async function runLeaseCleanup(cleanup: LeaseCleanup): Promise<boolean> {
  if (!cleanup.admissionSettled) {
    return false;
  }
  if (!cleanup.rowDeleted) {
    if (!(await deleteRunLeaseRowWithRetries(cleanup))) {
      return false;
    }
    cleanup.rowDeleted = true;
  }
  return !cleanup.gitRetained || (await releaseGitLock(cleanup));
}

async function drainPendingLeaseCleanups(): Promise<void> {
  for (const cleanup of pendingLeaseCleanups) {
    if (await runLeaseCleanup(cleanup)) {
      pendingLeaseCleanups.delete(cleanup);
    }
  }
}

function ensureExitCleanupRegistered(): void {
  if (exitCleanupRegistered) {
    return;
  }
  exitCleanupRegistered = true;
  // Only settled admissions can be deleted synchronously; unknown writers may still insert.
  process.on("exit", () => {
    for (const cleanup of pendingLeaseCleanups) {
      if (cleanup.admissionSettled && !cleanup.rowDeleted) {
        try {
          cleanup.context.admission.assertCurrent();
          releaseWorktreeRunLeaseRow(cleanup.context.environment, cleanup.id, cleanup.token);
        } catch {
          // Best effort at exit; the dead pid also lets a later process prune it.
        }
      }
    }
  });
}

export async function acquireWorktreeRunLease(
  id: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    exclusive?: true;
    /** Creation can reconcile a missing checkout while retaining exclusive registry custody. */
    allowMissingCheckout?: true;
  } = {},
): Promise<WorktreeRunLease> {
  const env = opts.env ?? process.env;
  ensureExitCleanupRegistered();
  // Retry any cleanup a prior run could not finish before starting a new one.
  await drainPendingLeaseCleanups();
  const token = randomUUID();
  const pid = process.pid;
  const startTime = getFileLockProcessStartTime(pid);
  const context = captureOpenClawStateWorkerContext({ env });
  const cleanup: LeaseCleanup = {
    env,
    context,
    id,
    token,
    rowDeleted: false,
    admissionSettled: false,
    gitRetained: false,
    refcountReleased: true,
  };
  // Serialize refcount and Git transitions so a cleanup retry cannot unlock a
  // newer same-process holder after a prior generation's unlock failed.
  try {
    await admitWorktreeRunLeaseRowAsync(
      context,
      {
        worktreeId: id,
        token,
        pid,
        startTime,
        now: Date.now(),
        ...(opts.exclusive || opts.allowMissingCheckout ? { exclusive: true } : {}),
      },
      (kind) => {
        cleanup.admissionSettled = kind !== "unknown";
        cleanup.rowDeleted = kind === "not-entered";
      },
    );
    const record = opts.allowMissingCheckout ? await readRegistryWorktree(context, id) : undefined;
    if (!record || (await worktreePathExists(record.path))) {
      await retainGitLock(context, id);
      cleanup.gitRetained = true;
      cleanup.refcountReleased = false;
    }
    context.admission.assertCurrent();
  } catch (error) {
    if (!(await runLeaseCleanup(cleanup))) {
      pendingLeaseCleanups.add(cleanup);
    }
    throw error;
  }
  let release: Promise<void> | undefined;
  return {
    id,
    token,
    release: () =>
      (release ??= runLeaseCleanup(cleanup).then((complete) => {
        if (!complete) {
          pendingLeaseCleanups.add(cleanup);
        }
      })),
  };
}

export function claimWorktreeRemoval(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    token: string;
    retiredExact?: true;
    retiredRemoval?: true;
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
  },
): Promise<void> {
  const pid = process.pid;
  return claimWorktreeRemovalRow(env, {
    ...params,
    pid,
    startTime: getFileLockProcessStartTime(pid),
    now: Date.now(),
  });
}

export function hasLiveWorktreeRunLease(env: NodeJS.ProcessEnv, worktreeId: string): boolean {
  return hasLiveWorktreeRunLeaseRow(env, worktreeId);
}

const testing = {
  drainPendingCleanupsForTest: drainPendingLeaseCleanups,
  resetForTest(): void {
    heldGitLocks.clear();
    gitLockTransitionTails.clear();
    pendingLeaseCleanups.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.worktreeRunLeaseTestApi")] = {
    testing,
  };
}
