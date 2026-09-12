import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeGitWorktreeOperation } from "../agents/worktrees/git-worktree-operations.runtime.js";
import { executeGitReadOperation } from "./git-read-operations.runtime.js";
import { serializeGitWorkerFailure, withGitWorkerContext } from "./git-worker-context.js";
import type { GitWorkerCommand, GitWorkerReply, GitWorkerResult } from "./git-worker-contract.js";
import { serveWorkerTasks } from "./worker-task-pool.js";

serveWorkerTasks<GitWorkerReply<GitWorkerResult>>(async (input, channel) => {
  try {
    if (!channel || !isRecord(input) || typeof input.type !== "string" || !isRecord(input.input)) {
      throw new Error("Git worker requires a typed operation and host channel");
    }
    // SAFETY: This private entry consumes only commands created by its typed host broker.
    const command = input as GitWorkerCommand;
    channel.consumeInput();
    const value = await withGitWorkerContext<GitWorkerResult>(channel, () => {
      switch (command.type) {
        case "worktree.snapshot":
        case "worktree.provisioning-inspection":
        case "worktree.cleanup-inspection":
        case "worktree.git-size":
        case "worktree.directory-size":
          return executeGitWorktreeOperation(command);
        default:
          return executeGitReadOperation(command);
      }
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: serializeGitWorkerFailure(error) };
  }
});
