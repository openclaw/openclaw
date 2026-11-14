import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runCommandWithTimeout, runExec, spawnCommand } from "../../process/exec.js";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import type { RepositoryGitHistory } from "./session-repository-checkpoints.types.js";
import { boundedWorkerError } from "./worker-error.js";
import { computeWorkspaceManifest } from "./workspace-manifest-worker.js";
import {
  requireWorkspaceResultGit as git,
  withWorkspaceResultRefMutation,
  workspaceResultGitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS,
} from "./workspace-result-git.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
} from "./workspace-result-inventory.js";

export async function importWorkerWorkspaceHistory(params: {
  root: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<void> {
  const history = params.gitHistory;
  if (
    !history?.descendsFromBase ||
    history.unavailableReason ||
    history.headCommit === history.baseCommit
  ) {
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
        baseEnv: params.baseEnv,
        timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    await pack.close();
  }
  // Verify the received graph, not just the worker's ancestry claim.
  await git(params.root, ["merge-base", "--is-ancestor", history.baseCommit, history.headCommit], {
    baseEnv: params.baseEnv,
  });
  params.assertCurrent?.();
}

/** Reclaim advances only an unchanged managed branch; file reconciliation already ran. */
export async function adoptStagedWorkerWorkspaceHistory(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  const { gitHistory: history } = await computeWorkspaceManifest({
    type: "workspace.manifest.result",
    input: { root: params.root, ref: params.stagedResultRef },
  });
  return adoptWorkerWorkspaceHistory({ ...params, gitHistory: history });
}

export const workerHistoryNotAdopted = (reason: string) =>
  `Cloud worker commits were not adopted: ${reason}. File changes were reconciled and kept for review.`;

export function repositoryHistoryNote(
  baseCommit: string,
  history: { gitHistory?: WorkerWorkspaceGitHistory; gitHistoryNote?: string },
): string | undefined {
  if (history.gitHistoryNote) {
    return history.gitHistoryNote;
  }
  const gitHistory = history.gitHistory;
  if (!gitHistory) {
    return workerHistoryNotAdopted("worker did not provide Git history");
  }
  if (gitHistory.baseCommit !== baseCommit) {
    return workerHistoryNotAdopted("worker history does not descend from the dispatch base");
  }
  if (gitHistory.unavailableReason) {
    return workerHistoryNotAdopted(gitHistory.unavailableReason);
  }
  return gitHistory.descendsFromBase
    ? undefined
    : workerHistoryNotAdopted("worker history does not descend from the dispatch base");
}

export async function restoreWorkerWorkspaceHistory(params: {
  root: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  if (params.gitHistoryNote) {
    return params.gitHistoryNote;
  }
  try {
    await importWorkerWorkspaceHistory(params);
    return await adoptWorkerWorkspaceHistory(params);
  } catch {
    params.assertCurrent?.();
    return workerHistoryNotAdopted("retained Git history could not be verified");
  }
}

async function adoptWorkerWorkspaceHistory(params: {
  root: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  const history = params.gitHistory;
  if (!history) {
    return undefined;
  }
  const fallback = workerHistoryNotAdopted;
  if (history.unavailableReason) {
    return fallback(history.unavailableReason);
  }
  if (history.headCommit === history.baseCommit) {
    return undefined;
  }
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

export const REPOSITORY_HISTORY_MESSAGE = "OpenClaw repository Git delta\n";

export async function withRepositoryCheckpointHistory<T>(
  params: { root: string; checkpointRef: string; baseCommit: string; requireGitHistory?: boolean },
  use: (history: RepositoryGitHistory) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let retained: RepositoryGitHistory;
  try {
    try {
      const parents = (
        await git(params.root, ["rev-list", "--parents", "-n", "1", params.checkpointRef])
      ).split(" ");
      if (parents.length === 1) {
        retained = {
          gitHistoryNote: workerHistoryNotAdopted("checkpoint has no retained Git history"),
        };
      } else {
        const parent = parents[1]!;
        const message = await git(params.root, ["show", "-s", "--format=%B", parent]);
        if (!message.startsWith(REPOSITORY_HISTORY_MESSAGE)) {
          throw new Error("repository Git history metadata is missing");
        }
        const record: unknown = JSON.parse(message.slice(REPOSITORY_HISTORY_MESSAGE.length));
        if (!isRecord(record)) {
          throw new Error("repository Git history metadata is invalid");
        }
        const retainedGitHistory =
          record.gitHistory === undefined
            ? undefined
            : WorkerWorkspaceGitHistorySchema.parse(record.gitHistory);
        if (retainedGitHistory && retainedGitHistory.baseCommit !== params.baseCommit) {
          throw new Error("repository Git history base changed");
        }
        retained = { gitHistory: retainedGitHistory };
        if (typeof record.gitHistoryNote === "string") {
          retained = { gitHistory: retainedGitHistory, gitHistoryNote: record.gitHistoryNote };
        } else if (
          retainedGitHistory &&
          retainedGitHistory.headCommit !== retainedGitHistory.baseCommit
        ) {
          const object = `${parent}:history.pack`;
          const size = Number(await git(params.root, ["cat-file", "-s", object]));
          if (!Number.isSafeInteger(size) || size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
            throw new Error("retained Git pack exceeds its byte limit");
          }
          directory = await fs.mkdtemp(
            path.join(resolvePreferredOpenClawTmpDir(), "repository-history-"),
          );
          const gitPackPath = path.join(directory, "history.pack");
          await spawnCommand(workspaceResultGitCommand(params.root, ["cat-file", "blob", object]), {
            stdout: { file: gitPackPath },
            executionTimeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
          });
          retained = { gitHistory: retainedGitHistory, gitPackPath };
        }
      }
    } catch (error) {
      retained = { gitHistoryNote: workerHistoryNotAdopted(boundedWorkerError(error)) };
    }
    if (params.requireGitHistory && repositoryHistoryNote(params.baseCommit, retained)) {
      throw new Error("Repository checkpoint requires complete Git history; retry the disk export");
    }
    return await use(retained);
  } finally {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
