import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { workerSshCommandOptions } from "./ssh.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { changedPaths, manifestNodes } from "./workspace-reconcile.js";
import {
  parseManifestRef,
  workerWorkspaceCommandSucceeded,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";
import {
  REMOTE_WORKSPACE_MANIFEST_JS,
  REMOTE_WORKSPACE_REMOVE_PATHS_JS,
} from "./workspace-sync-scripts.js";

const WORKSPACE_TIMEOUT_MS = 10 * 60_000;

export function createAcceptedWorkspacePublisher(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
  ownerSignal: AbortSignal;
  rsyncSsh: string;
  scpTarget: string;
  localPath: string;
  remoteWorkspaceDir: string;
  remoteManifest: WorkerWorkspaceManifest;
}) {
  return async (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => {
    const acceptedRaw = serializeWorkerWorkspaceManifest(accepted.manifest);
    const acceptedDigest = createHash("sha256").update(acceptedRaw).digest("hex");
    if (`sha256:${acceptedDigest}` !== accepted.manifestRef) {
      throw new Error("Accepted workspace manifest does not match its reference");
    }
    const published = await params.runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.remoteWorkspaceDir,
        "",
        "publish",
        acceptedDigest,
      ],
      input: acceptedRaw,
    });
    if (!workerWorkspaceCommandSucceeded(published)) {
      throw workspaceSyncError(published);
    }

    const changed = changedPaths(params.remoteManifest, accepted.manifest);
    if (changed.size > 0) {
      const removed = await params.runWorkspaceCommand({
        argv: ["node", "-e", REMOTE_WORKSPACE_REMOVE_PATHS_JS, params.remoteWorkspaceDir],
        input: JSON.stringify([...changed]),
      });
      if (!workerWorkspaceCommandSucceeded(removed)) {
        throw workspaceSyncError(removed);
      }
      const acceptedNodes = manifestNodes(accepted.manifest);
      const transferPaths = [...changed].filter((entryPath) => acceptedNodes.has(entryPath));
      if (transferPaths.length > 0) {
        const temporaryDirectory = await fs.mkdtemp(
          path.join(os.tmpdir(), "openclaw-worker-workspace-accepted-"),
        );
        const transferListPath = path.join(temporaryDirectory, "transfer-list");
        try {
          await fs.writeFile(
            transferListPath,
            Buffer.from(`${transferPaths.toSorted().join("\0")}\0`),
            { mode: 0o600 },
          );
          const localSource = params.localPath.endsWith(path.sep)
            ? params.localPath
            : `${params.localPath}${path.sep}`;
          const transferred = await params.runTask(
            [
              "rsync",
              "--archive",
              "--checksum",
              "--no-recursive",
              "--from0",
              `--files-from=${transferListPath}`,
              "-e",
              params.rsyncSsh,
              "--",
              localSource,
              `${params.scpTarget}:${params.remoteWorkspaceDir}/`,
            ],
            workerSshCommandOptions({
              timeoutMs: WORKSPACE_TIMEOUT_MS,
              signal: params.ownerSignal,
            }),
          );
          if (!workerWorkspaceCommandSucceeded(transferred)) {
            throw workspaceSyncError(transferred);
          }
        } finally {
          await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
      }
    }

    const verified = await params.runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.remoteWorkspaceDir,
        accepted.manifest.baseCommit ?? "",
        ...(accepted.manifest.baseCommit ? ["eligible", acceptedDigest] : []),
      ],
    });
    if (!workerWorkspaceCommandSucceeded(verified)) {
      throw workspaceSyncError(verified);
    }
    const verifiedRef = parseManifestRef(verified.stdout.trim());
    if (verifiedRef !== accepted.manifestRef) {
      throw new Error(
        `Worker workspace does not match its accepted manifest: expected ${accepted.manifestRef}, got ${verifiedRef}`,
      );
    }
  };
}

export function createAcceptedWorkspacePublisherFactory(
  params: Omit<Parameters<typeof createAcceptedWorkspacePublisher>[0], "remoteManifest">,
) {
  return (remoteManifest: WorkerWorkspaceManifest, initialRemoteRef: string) => {
    let expectedRemoteRef = initialRemoteRef;
    const publish = createAcceptedWorkspacePublisher({ ...params, remoteManifest });
    return {
      expectedRemoteRef: () => expectedRemoteRef,
      publishAcceptedManifest: async (accepted: {
        manifestRef: string;
        manifest: WorkerWorkspaceManifest;
        conflictPaths: string[];
      }) => {
        await publish(accepted);
        expectedRemoteRef = accepted.manifestRef;
      },
    };
  };
}
