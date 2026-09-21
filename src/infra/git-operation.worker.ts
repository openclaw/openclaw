import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serializeGitWorkerFailure, withGitWorkerContext } from "./git-worker-context.js";
import type { GitWorkerCommand, GitWorkerReply, GitWorkerResult } from "./git-worker-contract.js";
import { serveWorkerTasks } from "./worker-task-server.js";

serveWorkerTasks<GitWorkerReply<GitWorkerResult>>(
  async (input, channel) => {
    try {
      if (
        !channel ||
        !isRecord(input) ||
        typeof input.type !== "string" ||
        !isRecord(input.input)
      ) {
        throw new Error("Git worker requires a typed operation and host channel");
      }
      // SAFETY: This private entry consumes only commands created by its typed host broker.
      const command = input as GitWorkerCommand;
      channel.consumeInput();
      const value = await withGitWorkerContext<GitWorkerResult>(channel, () => {
        switch (command.type) {
          case "workspace.inventory.select":
          case "workspace.inventory.existing":
          case "workspace.inventory.paths":
          case "workspace.inventory.staged-directories":
            return import("../gateway/worker-environments/workspace-inventory-computation.runtime.js").then(
              ({ executeWorkspaceInventoryComputation }) =>
                executeWorkspaceInventoryComputation(command),
            );
          case "workspace.manifest.capture":
          case "workspace.manifest.snapshot":
          case "workspace.manifest.parse":
          case "workspace.manifest.serialize":
          case "workspace.manifest.overlay":
          case "workspace.manifest.pair":
          case "workspace.manifest.staged":
          case "workspace.manifest.stage-input":
          case "workspace.manifest.entries":
          case "workspace.manifest.file":
          case "workspace.manifest.nodes":
          case "workspace.reconcile.preflight":
            return import("../gateway/worker-environments/workspace-manifest-computation.runtime.js").then(
              ({ executeWorkspaceManifestComputation }) =>
                executeWorkspaceManifestComputation(command),
            );
          case "workspace.artifacts":
            return import("../gateway/worker-environments/workspace-result-inventory.runtime.js").then(
              ({ collectStagedWorkerArtifacts }) => collectStagedWorkerArtifacts(command.input),
            );
          case "worktree.snapshot":
          case "worktree.provisioning-inspection":
          case "worktree.cleanup-inspection":
          case "worktree.git-size":
          case "worktree.checkout-transition-size":
          case "worktree.directory-size":
            return import("../agents/worktrees/git-worktree-operations.runtime.js").then(
              ({ executeGitWorktreeOperation }) => executeGitWorktreeOperation(command),
            );
          default:
            return import("./git-read-operations.runtime.js").then(({ executeGitReadOperation }) =>
              executeGitReadOperation(command),
            );
        }
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: serializeGitWorkerFailure(error) };
    }
  },
  {
    transferList: (reply) =>
      reply.ok && reply.value instanceof Uint8Array && reply.value.buffer instanceof ArrayBuffer
        ? [reply.value.buffer]
        : [],
  },
);
