import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  manifestCaptureOutput,
  seedNodeWorkspaceRepositories,
  unchangedWorkspaceUpload,
  workspaceActions,
  workspaceCommandResult,
  workspaceSnapshot,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { memoryWorkspaceJournal } from "./tunnel.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { supported: false, failUpload: true },
  { supported: true, failUpload: true },
  { supported: true, failUpload: false },
])("negotiates Git results and fences HEAD changes: %j", async ({ supported, failUpload }) => {
  const localPath = temporary.make("node-result-local-");
  const remotePath = path.join(temporary.make("node-result-remote-"), "workspace");
  await fs.writeFile(path.join(localPath, "tracked.txt"), "same tree\n");
  const baseCommit = seedNodeWorkspaceRepositories(localPath, remotePath);
  const captured = await captureWorkspaceManifest({ root: localPath, baseCommit });
  const snapshot = workspaceSnapshot(localPath, captured.manifest);
  const baseManifestRef = snapshot.manifestRef;
  const workspace = {
    source: {
      kind: "local" as const,
      path: localPath,
      stagedResult: { ref: "refs/openclaw/worker-results/test", record: () => {} },
      journal: memoryWorkspaceJournal(),
    },
    remoteWorkspaceDir: remotePath,
    baseManifestRef,
  };
  const finished = new Error("upload failed");
  const revoke = vi.fn(async () => {});
  const actions = workspaceActions({
    supportsGitResults: async () => supported,
    restoredWorkspace: { ...workspace, manifestRef: baseManifestRef },
    workspaceTransfer: workspaceTransfer({
      prepareUpload: () => "upload-token",
      revoke,
      takeUpload: () => ({
        ...unchangedWorkspaceUpload(snapshot, temporary.make("node-result-staging-")),
        gitHistory: { baseCommit, headCommit: baseCommit, descendsFromBase: true },
      }),
    }),
    runWorkspaceCommand: async (command) => {
      if (command.transfer?.direction === "upload") {
        expect(command.transfer.resultVersion).toBe(supported ? 2 : undefined);
        if (failUpload) {
          throw finished;
        }
      }
      return workspaceCommandResult(remotePath, {
        stdout: command.transfer
          ? baseManifestRef
          : command.argv[0] === "git"
            ? "b".repeat(40)
            : manifestCaptureOutput(baseManifestRef),
      });
    },
  });
  if (failUpload) {
    await expect(actions.reconcileWorkspace(workspace)).rejects.toBe(finished);
  } else {
    const result = await actions.reconcileWorkspace(workspace);
    await expect(result.verifyStable()).rejects.toThrow("Git HEAD changed");
    await result.discardPreparedStagedResult?.();
  }
  expect(revoke).toHaveBeenCalledExactlyOnceWith("environment-1", "upload-token");
});
