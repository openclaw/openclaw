import { constants } from "node:fs";
import fs from "node:fs/promises";
import { runCommandWithTimeout, runExec } from "../../process/exec.js";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import { loadStagedWorkspaceManifest } from "./workspace-manifest-worker.js";
import {
  requireWorkspaceResultGit as git,
  withWorkspaceResultRefMutation,
  workspaceResultGitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS,
} from "./workspace-result-git.js";
import type { WorkerWorkspaceGitHistory } from "./workspace-result-inventory.js";

export async function importWorkerWorkspaceHistory(params: {
  root: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const history = params.gitHistory;
  if (!history?.descendsFromBase || history.headCommit === history.baseCommit) {
    return;
  }
  if (!params.gitPackPath) {
    throw new Error("Cloud workspace Git history has no pack");
  }
  const pack = await fs.open(params.gitPackPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await pack.stat();
    if (!info.isFile() || info.size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
      throw new Error("Cloud workspace Git pack exceeds its byte limit");
    }
    params.assertCurrent?.();
    await runExec(
      "git",
      workspaceResultGitCommand(params.root, [
        "index-pack",
        "--stdin",
        "--fix-thin",
        "--strict",
      ]).slice(1),
      {
        stdinFileDescriptor: pack.fd,
        timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    await pack.close();
  }
  // Verify the received graph, not just the worker's ancestry claim.
  await git(params.root, ["merge-base", "--is-ancestor", history.baseCommit, history.headCommit]);
  params.assertCurrent?.();
}

/** Reclaim advances only an unchanged managed branch; file reconciliation already ran. */
export async function adoptStagedWorkerWorkspaceHistory(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  const { gitHistory: history } = await loadStagedWorkspaceManifest(
    params.root,
    params.stagedResultRef,
  );
  if (!history || history.headCommit === history.baseCommit) {
    return undefined;
  }
  const fallback = (reason: string) =>
    `Cloud worker commits were not adopted: ${reason}. File changes were reconciled and kept for review.`;
  if (!history.descendsFromBase) {
    return fallback("worker history does not descend from the dispatch base");
  }
  await git(params.root, ["merge-base", "--is-ancestor", history.baseCommit, history.headCommit]);
  return await withWorkspaceResultRefMutation(params.root, async (baseEnv) => {
    const branch = await runCommandWithTimeout(
      workspaceResultGitCommand(params.root, ["symbolic-ref", "--quiet", "HEAD"]),
      {
        timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
        baseEnv,
      },
    );
    if (branch.code === 1) {
      return fallback("the Gateway checkout has no managed branch");
    }
    if (branch.code !== 0) {
      throw new Error(branch.stderr || "Cannot read the Gateway workspace branch");
    }
    const ref = branch.stdout.trim();
    const head = await git(params.root, ["rev-parse", ref], { baseEnv });
    if (head !== history.baseCommit && head !== history.headCommit) {
      return fallback("the Gateway branch moved since dispatch");
    }
    const mergeIndex = ["read-tree", "-i", "-m", history.baseCommit, history.headCommit];
    const preflight = await runCommandWithTimeout(
      workspaceResultGitCommand(params.root, [...mergeIndex, "--dry-run"]),
      { timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS, baseEnv },
    );
    if (preflight.code !== 0) {
      return fallback("the Gateway's staged changes conflict with worker commits");
    }
    params.assertCurrent?.();
    if (head === history.baseCommit) {
      try {
        await git(
          params.root,
          [
            "update-ref",
            "-m",
            "adopt cloud worker commits",
            ref,
            history.headCommit,
            history.baseCommit,
          ],
          { baseEnv },
        );
      } catch (error) {
        if ((await git(params.root, ["rev-parse", ref], { baseEnv })) !== history.baseCommit) {
          return fallback("the Gateway branch moved since dispatch");
        }
        throw error;
      }
    }
    // Merge the index without touching reconciled files or discarding staged-only content.
    // Explicit trees also make recovery after the ref update repeatable.
    params.assertCurrent?.();
    await git(params.root, mergeIndex, { baseEnv });
    return undefined;
  });
}
