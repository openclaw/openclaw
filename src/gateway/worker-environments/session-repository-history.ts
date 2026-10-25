import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runExec, spawnCommand } from "../../process/exec.js";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  requireWorkspaceResultGit as git,
  workspaceResultGitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS,
} from "./workspace-result-git.js";
import { workerHistoryNotAdopted } from "./workspace-result-history.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
} from "./workspace-result-inventory.js";

const MARKER = "OpenClaw repository Git delta\n";
export type RepositoryGitHistory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
};

/** The checkpoint owns this synthetic parent; the pack stays opaque until a base is fetched. */
export async function stageRepositoryGitHistory(
  params: RepositoryGitHistory & {
    root: string;
    baseCommit: string;
    assertCurrent: () => void;
  },
): Promise<{ parentCommit?: string; gitHistoryNote?: string }> {
  const history = params.gitHistory;
  let note = params.gitHistoryNote;
  let blob: string | undefined;
  if (!note) {
    if (!history) {
      note = workerHistoryNotAdopted("worker did not provide Git history");
    } else if (history.baseCommit !== params.baseCommit) {
      note = workerHistoryNotAdopted("worker history does not descend from the dispatch base");
    } else if (history.unavailableReason) {
      note = workerHistoryNotAdopted(history.unavailableReason);
    } else if (!history.descendsFromBase) {
      note = workerHistoryNotAdopted("worker history does not descend from the dispatch base");
    } else if (history.headCommit !== history.baseCommit) {
      try {
        if (!params.gitPackPath) {
          throw new Error("worker Git history has no pack");
        }
        const pack = await fs.open(params.gitPackPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await pack.stat();
          if (!stat.isFile() || stat.size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
            throw new Error("worker Git pack exceeds its byte limit");
          }
          params.assertCurrent();
          blob = (
            await runExec(
              "git",
              workspaceResultGitCommand(params.root, ["hash-object", "-w", "--stdin"]).slice(1),
              {
                stdinFileDescriptor: pack.fd,
                timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
              },
            )
          ).stdout.trim();
        } finally {
          await pack.close();
        }
      } catch (error) {
        params.assertCurrent();
        note = workerHistoryNotAdopted(boundedWorkerError(error));
      }
    }
  }
  params.assertCurrent();
  const tree = await git(params.root, ["mktree"], {
    input: Buffer.from(blob ? `100644 blob ${blob}\thistory.pack\n` : ""),
  });
  params.assertCurrent();
  const parentCommit = await git(
    params.root,
    [
      "-c",
      "user.name=OpenClaw",
      "-c",
      "user.email=openclaw@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
    ],
    {
      input: Buffer.from(
        MARKER + JSON.stringify({ gitHistory: history, gitHistoryNote: note }) + "\n",
      ),
      baseEnv: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenClaw",
        GIT_COMMITTER_NAME: "OpenClaw",
        GIT_AUTHOR_EMAIL: "openclaw@localhost",
        GIT_COMMITTER_EMAIL: "openclaw@localhost",
        GIT_AUTHOR_DATE: "@0 +0000",
        GIT_COMMITTER_DATE: "@0 +0000",
      },
    },
  );
  return { parentCommit, ...(note ? { gitHistoryNote: note } : {}) };
}

export async function withRepositoryGitHistory<T>(
  params: { root: string; checkpointRef: string; baseCommit: string },
  use: (history: RepositoryGitHistory) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let retained: RepositoryGitHistory = {};
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
        if (!message.startsWith(MARKER)) {
          throw new Error("repository Git history metadata is missing");
        }
        const record: unknown = JSON.parse(message.slice(MARKER.length));
        if (!isRecord(record)) {
          throw new Error("repository Git history metadata is invalid");
        }
        const history =
          record.gitHistory === undefined
            ? undefined
            : WorkerWorkspaceGitHistorySchema.parse(record.gitHistory);
        if (history && history.baseCommit !== params.baseCommit) {
          throw new Error("repository Git history base changed");
        }
        if (typeof record.gitHistoryNote === "string") {
          retained = { gitHistory: history, gitHistoryNote: record.gitHistoryNote };
        } else if (history && history.headCommit !== history.baseCommit) {
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
          retained = { gitHistory: history, gitPackPath };
        }
      }
    } catch (error) {
      retained = { gitHistoryNote: workerHistoryNotAdopted(boundedWorkerError(error)) };
    }
    return await use(retained);
  } finally {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
