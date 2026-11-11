import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SpawnResult } from "../../process/exec.js";
import {
  MAX_WORKSPACE_RESULT_GIT_PACK_BYTES,
  NODE_WORKSPACE_GIT_HISTORY_SCRIPT,
} from "../../worker/node-workspace-transfer-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
} from "./workspace-result-inventory.js";
import {
  workerWorkspaceCommandSucceeded as success,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";

/** Owns the private Git-history artifact for one SSH reconciliation. */
export function createSshWorkspaceHistoryTransfer(params: {
  remoteWorkspaceDir: string;
  temporaryDirectory: string;
  scpTarget: string;
  bandwidthLimitKiB: number;
  runWorkspaceCommand: WorkerWorkspaceTunnelHandle["runWorkspaceCommand"];
  runBoundedInboundRsync: (request: {
    argv: (rsyncSsh: string) => string[];
    destinationRoot: string;
    entryLimit: number;
    totalByteLimit: number;
  }) => Promise<SpawnResult>;
}) {
  const remoteGitPackPath = path.posix.join(
    path.posix.dirname(params.remoteWorkspaceDir),
    `.openclaw-result-${randomBytes(16).toString("hex")}.pack`,
  );
  let captureStarted = false;
  let gitHistory: WorkerWorkspaceGitHistory | undefined;
  return {
    async capture(baseCommit: string | null) {
      if (!baseCommit) {
        return undefined;
      }
      captureStarted = true;
      const captured = await params.runWorkspaceCommand({
        transportRetry: "never",
        argv: [
          "node",
          "-e",
          NODE_WORKSPACE_GIT_HISTORY_SCRIPT,
          params.remoteWorkspaceDir,
          baseCommit,
          remoteGitPackPath,
        ],
      });
      if (!success(captured)) {
        throw workspaceSyncError(captured);
      }
      gitHistory = WorkerWorkspaceGitHistorySchema.parse(JSON.parse(captured.stdout));
      return gitHistory;
    },
    async verifyStable() {
      if (!gitHistory) {
        return;
      }
      const head = await params.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["git", "-C", params.remoteWorkspaceDir, "rev-parse", "--verify", "HEAD"],
      });
      if (!success(head)) {
        throw workspaceSyncError(head);
      }
      if (head.stdout.trim() !== gitHistory.headCommit) {
        throw new Error("Cloud workspace Git HEAD changed during final reconciliation");
      }
    },
    async downloadPack(): Promise<string | undefined> {
      if (!gitHistory?.descendsFromBase || gitHistory.headCommit === gitHistory.baseCommit) {
        return undefined;
      }
      const gitPackRoot = path.join(params.temporaryDirectory, "history");
      await fs.mkdir(gitPackRoot, { mode: 0o700 });
      const gitPackPath = path.join(gitPackRoot, "result.pack");
      const transferred = await params.runBoundedInboundRsync({
        argv: (rsyncSsh) => [
          "rsync",
          "--archive",
          "--inplace",
          "--no-recursive",
          `--max-size=${MAX_WORKSPACE_RESULT_GIT_PACK_BYTES}`,
          `--bwlimit=${params.bandwidthLimitKiB}`,
          "-e",
          rsyncSsh,
          "--",
          `${params.scpTarget}:${remoteGitPackPath}`,
          gitPackPath,
        ],
        destinationRoot: gitPackRoot,
        entryLimit: 1,
        totalByteLimit: MAX_WORKSPACE_RESULT_GIT_PACK_BYTES,
      });
      if (!success(transferred)) {
        throw workspaceSyncError(transferred);
      }
      const pack = await fs.lstat(gitPackPath);
      if (!pack.isFile() || pack.size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
        throw new Error("Worker result Git pack exceeds its byte limit or is not a file");
      }
      return gitPackPath;
    },
    async cleanup() {
      if (!captureStarted) {
        return;
      }
      await params
        .runWorkspaceCommand({
          transportRetry: "idempotent",
          argv: [
            "node",
            "-e",
            'require("node:fs").rmSync(process.argv[1], { force: true })',
            remoteGitPackPath,
          ],
        })
        .catch(() => undefined);
    },
  };
}
