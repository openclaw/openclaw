import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { lockState, lockWorktreeForProcess } from "./git-lock.js";
import { listGitWorktrees } from "./git.js";
import {
  git,
  makeWorktreeRecord,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** A pid that has exited, so isPidDefinitelyDead reports ESRCH for it. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "close");
  if (pid === undefined) {
    throw new Error("failed to spawn probe process");
  }
  return pid;
}

async function lockedReason(repoRoot: string, worktreePath: string): Promise<string | undefined> {
  const entries = await listGitWorktrees(repoRoot);
  return entries.find((entry) => path.resolve(entry.path) === path.resolve(worktreePath))
    ?.lockedReason;
}

function setLock(record: ManagedWorktreeRecord, reason: string) {
  return git(record.repoRoot, "worktree", "lock", "--reason", reason, record.path);
}

describe("lockWorktreeForProcess", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const initialize = useManagedWorktreeTestRepository();

  async function setupWorktree(): Promise<ManagedWorktreeRecord> {
    const root = await fs.realpath(tempDirs.make("openclaw-git-lock-"));
    const repo = await initialize(root);
    const worktreePath = path.join(root, "wt-lock");
    await git(repo, "worktree", "add", "-b", "wt-lock", worktreePath, "HEAD");
    return makeWorktreeRecord(repo, "wt-lock", {
      path: worktreePath,
      baseRef: "main",
      createdAt: 0,
      lastActiveAt: 0,
    });
  }

  it("reclaims a lock left behind by a dead OpenClaw process", async () => {
    const record = await setupWorktree();
    const stalePid = await exitedPid();
    await setLock(record, `openclaw pid=${stalePid}`);
    expect(await lockState(record)).toEqual({ kind: "dead", pid: stalePid });

    await expect(lockWorktreeForProcess(record)).resolves.toBe(true);

    expect(await lockedReason(record.repoRoot, record.path)).toBe(`openclaw pid=${process.pid}`);
  });

  it.each([`openclaw pid=${process.ppid}`, "held by hand"])(
    "keeps another owner's lock: %s",
    async (reason) => {
      const record = await setupWorktree();
      await setLock(record, reason);
      await expect(lockWorktreeForProcess(record)).rejects.toThrow(/git worktree lock/);
      expect(await lockedReason(record.repoRoot, record.path)).toBe(reason);
    },
  );

  it("reports new and existing same-process lock ownership", async () => {
    const record = await setupWorktree();
    await expect(lockWorktreeForProcess(record)).resolves.toBe(true);

    await expect(lockWorktreeForProcess(record)).resolves.toBe(false);

    expect(await lockedReason(record.repoRoot, record.path)).toBe(`openclaw pid=${process.pid}`);
  });
});
