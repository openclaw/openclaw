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

/** One GC pass may skip these paths; removal still rechecks locks and HEAD under its lease. */
export function createWorktreeGcPrefilter() {
  type Entry = Awaited<ReturnType<typeof listGitWorktrees>>[number];
  const repositories = new Map<string, Promise<Map<string, Entry>>>();
  return async (record: ManagedWorktreeRecord) => {
    const root = path.resolve(record.repoRoot);
    let reasons = repositories.get(root);
    if (!reasons) {
      reasons = listGitWorktrees(root).then(
        (entries) => new Map(entries.map((entry) => [path.resolve(entry.path), entry])),
      );
      repositories.set(root, reasons);
    }
    const entry = (await reasons).get(path.resolve(record.path));
    const state = classifyLockReason(entry?.lockedReason);
    if (state.kind === "live" || state.kind === "foreign") {
      return "worktree has a live or foreign lock";
    }
    if (entry?.branch !== undefined && entry.branch !== `refs/heads/${record.branch}`) {
      return "branch-moved";
    }
    return undefined;
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
  // Reclaim dead-pid residue, as remove()/release() do. Concurrent reclaimers can
  // both win this observe-then-unlock race; fixing it requires a guard shared by
  // all three paths (openclaw#114129).
  if (state.kind !== "dead") {
    throw commandError("git worktree lock", result);
  }
  await unlockWorktree(record);
  const retry = await runLock(record);
  if (retry.code !== 0 && !heldByThisProcess(await lockState(record))) {
    throw commandError("git worktree lock", retry);
  }
}

export async function unlockWorktree(
  record: ManagedWorktreeRecord,
  options?: Pick<NonNullable<Parameters<typeof runGit>[2]>, "signal" | "beforeRun">,
): Promise<void> {
  const result = await runGit(record.repoRoot, ["worktree", "unlock", record.path], options);
  if (result.code !== 0) {
    throw commandError("git worktree unlock", result);
  }
}
