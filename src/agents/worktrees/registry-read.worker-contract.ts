import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { WorktreeRegistryReadOperations } from "./registry-read.worker.js";

export function isWorktreeRegistryReadCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<WorktreeRegistryReadOperations> {
  switch (command.type) {
    case "worktrees.get":
    case "worktrees.list":
    case "worktrees.liveIds":
    case "worktrees.provisionedPaths":
    case "worktrees.provisionedState":
    case "worktrees.provisionedChunk":
      return true;
    default:
      return false;
  }
}
