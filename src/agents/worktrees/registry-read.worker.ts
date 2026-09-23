import type { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  getRegistryWorktreeProvisionedChunkInDatabase,
  getRegistryWorktreeProvisionedPathsInDatabase,
  getRegistryWorktreeProvisionedStateInDatabase,
  listLiveRegistryWorktreeIdsInDatabase,
  listRegistryWorktreesInDatabase,
} from "./registry-read.kernel.js";
import type { ManagedWorktreeRecord, ProvisionedFileState } from "./types.js";

export type WorktreeRegistryReadOperations = {
  "worktrees.list": { input: undefined; output: ManagedWorktreeRecord[] };
  "worktrees.liveIds": { input: undefined; output: string[] };
  "worktrees.provisionedPaths": { input: { id: string }; output: string[] | undefined };
  "worktrees.provisionedState": {
    input: { id: string };
    output: ProvisionedFileState[] | undefined;
  };
  "worktrees.provisionedChunk": {
    input: { worktreeId: string; path: string; chunkIndex: number };
    output: Uint8Array | undefined;
  };
};

export function isWorktreeRegistryReadCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<WorktreeRegistryReadOperations> {
  switch (command.type) {
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

export function executeWorktreeRegistryReadCommand(
  database: DatabaseSync,
  command: SqliteWorkerCommand<WorktreeRegistryReadOperations>,
): WorktreeRegistryReadOperations[keyof WorktreeRegistryReadOperations]["output"] {
  if (command.type === "worktrees.list") {
    return listRegistryWorktreesInDatabase(database);
  }
  if (command.type === "worktrees.liveIds") {
    return listLiveRegistryWorktreeIdsInDatabase(database);
  }
  if (command.type === "worktrees.provisionedPaths") {
    return getRegistryWorktreeProvisionedPathsInDatabase(database, command.input.id);
  }
  if (command.type === "worktrees.provisionedState") {
    return getRegistryWorktreeProvisionedStateInDatabase(database, command.input.id);
  }
  return getRegistryWorktreeProvisionedChunkInDatabase(database, command.input);
}
