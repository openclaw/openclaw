import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type { DiffReadTiming } from "./diff-read-timing.js";
import { serializeGitWorkerFailure, withGitWorkerContext } from "./git-worker-context.js";
import type { GitWorkerCommand, GitWorkerReply, GitWorkerResult } from "./git-worker-contract.js";
import { serveWorkerTasks } from "./worker-task-server.js";

serveWorkerTasks<GitWorkerReply<GitWorkerResult>, GitWorkerCommand>(
  async (command, channel, control) => {
    try {
      if (!channel) {
        throw new Error("Git worker requires a typed operation and host channel");
      }
      channel.consumeInput();
      const diffTiming: DiffReadTiming | undefined =
        command.type === "checkout.revision" && command.input.scope === "diff"
          ? { durations: {} }
          : undefined;
      const value = await withGitWorkerContext<GitWorkerResult>(
        channel,
        () => {
          switch (command.type) {
            case "workspace.inventory.select":
            case "workspace.inventory.existing":
            case "workspace.inventory.paths":
            case "workspace.inventory.staged-directories":
              return import("../gateway/worker-environments/workspace-inventory-computation.runtime.js").then(
                ({ executeWorkspaceInventoryComputation }) =>
                  executeWorkspaceInventoryComputation(command),
              );
            case "workspace.manifest.local":
            case "workspace.manifest.capture":
            case "workspace.manifest.base-refresh":
            case "workspace.manifest.equal":
            case "workspace.manifest.snapshot":
            case "workspace.manifest.document":
            case "workspace.manifest.reference":
            case "workspace.manifest.parse":
            case "workspace.manifest.paths":
            case "workspace.manifest.serialize":
            case "workspace.manifest.overlay":
            case "workspace.manifest.pair":
            case "workspace.manifest.staged":
            case "workspace.manifest.entries":
            case "workspace.manifest.file":
            case "workspace.manifest.nodes":
            case "workspace.reconcile.preflight":
              return import("../gateway/worker-environments/workspace-manifest-computation.runtime.js").then(
                ({ executeWorkspaceManifestComputation }) =>
                  executeWorkspaceManifestComputation(command),
              );
            case "workspace.manifest.stage-input":
            case "workspace.manifest.tree-input":
            case "workspace.manifest.remote-capture":
              // Streamed fs-safe creation owns native descriptors until cleanup settles.
              return control.runNativeSection(async () => {
                const { executeWorkspaceManifestComputation } =
                  await import("../gateway/worker-environments/workspace-manifest-computation.runtime.js");
                return await executeWorkspaceManifestComputation(command, control.throwIfCancelled);
              });
            case "workspace.artifacts":
              return import("../gateway/worker-environments/workspace-result-inventory.runtime.js").then(
                ({ collectStagedWorkerArtifacts }) => collectStagedWorkerArtifacts(command.input),
              );
            case "worktree.eviction-purge":
              return control.runNativeSection(async () => {
                const { executeGitWorktreeOperation } =
                  await import("../agents/worktrees/git-worktree-operations.runtime.js");
                return await executeGitWorktreeOperation(command);
              });
            case "worktree.snapshot-verify-exact":
            case "worktree.snapshot":
            case "worktree.provisioning-inspection":
            case "worktree.cleanup-inspection":
            case "worktree.cleanup-fingerprint":
            case "worktree.eviction-classify":
            case "worktree.eviction-source":
            case "worktree.eviction-repositories":
            case "worktree.git-size":
            case "worktree.checkout-transition-size":
            case "worktree.directory-size":
              return import("../agents/worktrees/git-worktree-operations.runtime.js").then(
                ({ executeGitWorktreeOperation }) => executeGitWorktreeOperation(command),
              );
            case "repository.identities":
              return import("../agents/worktrees/repository-paths.js").then(
                async ({ resolveRepositoryIdentity }) =>
                  (
                    await runTasksWithConcurrency({
                      tasks: command.input.roots.map(
                        (root) => () => resolveRepositoryIdentity(root),
                      ),
                      limit: 4,
                    })
                  ).results,
              );
            case "repository.branches":
              return import("../agents/worktrees/branches.runtime.js").then(
                ({ readRepositoryBranches }) =>
                  readRepositoryBranches(command.input.repoRoot, command.input),
              );
            case "checkout.revision":
              return import("../gateway/control-ui-session-prs-git.runtime.js").then(
                ({ readCheckoutGitRevision }) => readCheckoutGitRevision(command.input, diffTiming),
              );
            case "checkout.context":
              return import("../gateway/control-ui-session-prs-git.runtime.js").then(
                ({ readCheckoutGitContext }) =>
                  readCheckoutGitContext(command.input.root, command.input.githubHost),
              );
            case "pull-request.branch-comparison":
              return import("../gateway/control-ui-session-prs-git.runtime.js").then(
                ({ readPullRequestBranchComparison }) =>
                  readPullRequestBranchComparison(command.input),
              );
            case "pull-request.branch-facts":
              return import("../gateway/control-ui-session-prs-git.runtime.js").then(
                ({ readPullRequestBranchFacts }) => readPullRequestBranchFacts(command.input),
              );
            case "checkout.diff":
              return import("../sessions/session-diff.runtime.js").then(({ collectCheckoutDiff }) =>
                collectCheckoutDiff(command.input),
              );
            case "checkout.baseline":
              return import("../sessions/session-diff.runtime.js").then(
                ({ collectCheckoutDiffBaseline }) => collectCheckoutDiffBaseline(command.input),
              );
          }
          throw new Error("Unsupported Git worker operation");
        },
        command.filesystemRefs,
      );
      return { ok: true, value, revisionUnavailableReason: diffTiming?.revisionUnavailableReason };
    } catch (error) {
      return { ok: false, error: serializeGitWorkerFailure(error) };
    } finally {
      // V8 retains the last successful regex input, including task-owned checkout paths.
      /(?:)/.test("");
    }
  },
  {
    transferList: (reply) =>
      reply.ok && reply.value instanceof Uint8Array && reply.value.buffer instanceof ArrayBuffer
        ? [reply.value.buffer]
        : [],
  },
);
