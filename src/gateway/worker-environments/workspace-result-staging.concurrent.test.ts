import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRuntime from "../../process/exec.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gitConfig = [
  `core.hooksPath=${os.devNull}`,
  "user.name=Workspace Test",
  "user.email=workspace@example.invalid",
  "commit.gpgsign=false",
].flatMap((setting) => ["-c", setting]);

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await commandRuntime.runCommandWithTimeout(
    ["git", ...gitConfig, "-C", root, ...args],
    { timeoutMs: 10_000 },
  );
  expect(result.code, result.stderr || result.stdout).toBe(0);
}

async function initializeRepository(root: string): Promise<void> {
  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
}

it("queues related worktree ref mutations while another repository progresses", async () => {
  const root = tempDirs.make("worker-result-ref-queue-");
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const unrelated = path.join(root, "unrelated");
  await initializeRepository(repository);
  await git(repository, "worktree", "add", "--quiet", "--detach", worktree);
  await initializeRepository(unrelated);
  const targets = [repository, worktree, unrelated].map((directory, index) => ({
    root: directory,
    stagedResultRef: preparedWorkerWorkspaceResultRef(workerWorkspaceResultRef(`claim-${index}`)),
  }));
  for (const target of targets) {
    await git(target.root, "update-ref", target.stagedResultRef, "HEAD");
  }
  await git(repository, "pack-refs", "--all");
  await git(unrelated, "pack-refs", "--all");

  const firstStarted = createDeferred();
  const secondReachedGit = createDeferred();
  const releaseFirst = createDeferred();
  const mutations: string[] = [];
  const runCommand = commandRuntime.runCommandWithTimeout;
  const spy = vi
    .spyOn(commandRuntime, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      const cwd = argv[argv.indexOf("-C") + 1];
      if (cwd === worktree) {
        secondReachedGit.resolve();
      }
      if (argv.includes("update-ref")) {
        mutations.push(cwd!);
        if (cwd === repository) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      }
      return await runCommand(argv, options);
    });
  const operations: Promise<void>[] = [];
  try {
    operations.push(deleteStagedWorkerWorkspaceResult(targets[0]!));
    await firstStarted.promise;
    operations.push(deleteStagedWorkerWorkspaceResult(targets[1]!));
    const independent = deleteStagedWorkerWorkspaceResult(targets[2]!);
    operations.push(independent);
    // Only the unrelated repository may mutate while the first writer is held.
    await Promise.all([secondReachedGit.promise, independent]);
    expect(mutations).toEqual([repository, unrelated]);
    await expect(hasWorkerWorkspaceResultRef(targets[1]!)).resolves.toBe(true);
    await expect(hasWorkerWorkspaceResultRef(targets[2]!)).resolves.toBe(false);
    releaseFirst.resolve();
    await Promise.all(operations);
    expect(mutations).toEqual([repository, unrelated, worktree]);
    for (const target of targets) {
      await expect(hasWorkerWorkspaceResultRef(target)).resolves.toBe(false);
    }
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled(operations);
    spy.mockRestore();
  }
});
