import path from "node:path";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { commandError, runGit, listGitWorktrees } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

const OPENCLAW_LOCK_PATTERN = /^openclaw pid=(\d+)$/;

type LockState =
  | { kind: "none" }
  | { kind: "live"; pid: number }
  | { kind: "dead"; pid: number }
  | { kind: "foreign"; reason: string };

export async function lockState(record: ManagedWorktreeRecord): Promise<LockState> {
  const entry = (await listGitWorktrees(record.repoRoot)).find(
    (candidate) => path.resolve(candidate.path) === path.resolve(record.path),
  );
  return classifyLockReason(entry?.lockedReason);
}

function classifyLockReason(reason: string | undefined): LockState {
  if (reason === undefined) {
    return { kind: "none" };
  }
  const match = OPENCLAW_LOCK_PATTERN.exec(reason);
  if (!match) {
    return { kind: "foreign", reason };
  }
  const pid = Number(match[1]);
  // A cross-user (EPERM) OpenClaw lock is treated as live so a run's checkout is
  // never removed under it; only an ESRCH/zombie owner counts as dead.
  return isPidDefinitelyDead(pid) ? { kind: "dead", pid } : { kind: "live", pid };
}

/** One GC pass may conservatively skip these paths; removal still rereads lockState. */
export function createWorktreeLockPrefilter(): (record: ManagedWorktreeRecord) => Promise<boolean> {
  const repositories = new Map<string, Promise<Map<string, string>>>();
  return async (record) => {
    const root = path.resolve(record.repoRoot);
    let reasons = repositories.get(root);
    if (!reasons) {
      reasons = listGitWorktrees(root).then((entries) => {
        const paths = new Map<string, string>();
        for (const entry of entries) {
          if (entry.lockedReason !== undefined) {
            paths.set(path.resolve(entry.path), entry.lockedReason);
          }
        }
        return paths;
      });
      repositories.set(root, reasons);
    }
    const state = classifyLockReason((await reasons).get(path.resolve(record.path)));
    return state.kind === "live" || state.kind === "foreign";
  };
}

function heldByThisProcess(state: LockState): boolean {
  return state.kind === "live" && state.pid === process.pid;
}

async function runLock(record: ManagedWorktreeRecord) {
  return await runGit(record.repoRoot, [
    "worktree",
    "lock",
    "--reason",
    `openclaw pid=${process.pid}`,
    record.path,
  ]);
}

export async function lockWorktreeForProcess(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runLock(record);
  if (result.code === 0) {
    return;
  }
  const state = await lockState(record);
  if (heldByThisProcess(state)) {
    return;
  }
  // A lock naming a dead OpenClaw pid is restart residue: the owner died (crash or
  // update restart) without unlocking, so git refuses every later lock forever and
  // the run would otherwise proceed unprotected. remove()/release() already treat a
  // dead owner as reclaimable, so reclaim it here instead of failing the acquire.
  // Accepted tradeoff: the observe-then-unlock window is the same one those two
  // callers already take, so two processes reclaiming the identical stale lock at
  // once can both believe they won. Closing it needs one reclaim guard shared by all
  // three paths -- this acquire plus service.ts release() and remove()
  // (openclaw#114129); today's behavior instead loses
  // the lock every time.
  if (state.kind !== "dead") {
    throw commandError("git worktree lock", result);
  }
  await unlockWorktree(record);
  const retry = await runLock(record);
  if (retry.code !== 0 && !heldByThisProcess(await lockState(record))) {
    throw commandError("git worktree lock", retry);
  }
}

export async function unlockWorktree(record: ManagedWorktreeRecord): Promise<void> {
  const result = await runGit(record.repoRoot, ["worktree", "unlock", record.path]);
  if (result.code !== 0) {
    throw commandError("git worktree unlock", result);
  }
}
