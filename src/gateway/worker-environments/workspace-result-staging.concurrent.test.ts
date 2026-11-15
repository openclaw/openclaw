import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRuntime from "../../process/exec.js";
import {
  deleteStagedWorkerWorkspaceResult as deleteResult,
  hasWorkerWorkspaceResultRef as hasRef,
  preparedWorkerWorkspaceResultRef as preparedRef,
  workerWorkspaceResultRef as resultRef,
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

it("queues related worktree ref mutations while another repository progresses", async () => {
  const repository = tempDirs.make("worker-result-main-");
  const unrelated = tempDirs.make("worker-result-unrelated-");
  const worktree = path.join(tempDirs.make("worker-result-linked-"), "worktree");
  for (const root of [repository, unrelated]) {
    await git(root, "init", "--quiet");
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  }
  await git(repository, "worktree", "add", "--quiet", "--detach", worktree);
  const targets = [repository, worktree, unrelated].map((directory, index) => ({
    root: directory,
    stagedResultRef: preparedRef(resultRef(`claim-${index}`)),
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
    operations.push(deleteResult(targets[0]!));
    await firstStarted.promise;
    operations.push(deleteResult(targets[1]!));
    const independent = deleteResult(targets[2]!);
    operations.push(independent);
    // Only the unrelated repository may mutate while the first writer is held.
    await Promise.all([secondReachedGit.promise, independent]);
    expect(mutations).toEqual([repository, unrelated]);
    await expect(hasRef(targets[1]!)).resolves.toBe(true);
    await expect(hasRef(targets[2]!)).resolves.toBe(false);
    releaseFirst.resolve();
    await Promise.all(operations);
    expect(mutations).toEqual([repository, unrelated, worktree]);
    for (const target of targets) {
      await expect(hasRef(target)).resolves.toBe(false);
    }
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled(operations);
    spy.mockRestore();
  }
});
