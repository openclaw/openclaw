import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db-contract.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import {
  isWorktreeRegistryReadCommand,
  executeWorktreeRegistryReadCommand,
  type WorktreeRegistryReadOperations,
} from "./registry-read.worker.js";
import {
  retireMissingWorktreeInWorker,
  deferWorktreeCleanupInWorker,
  type WorktreeRetirementOperations,
} from "./registry-retirement.worker.js";
import { executeWorktreeRunLeaseCommand } from "./run-lease-store.worker.js";

type WorktreeWorkerOperations = WorktreeRegistryReadOperations &
  WorktreeRetirementOperations &
  Pick<
    OpenClawStateWorkerOperations,
    "worktrees.admitRunLease" | "worktrees.releaseRunLease" | "worktrees.reapRunLeases"
  >;

export function isWorktreeWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<WorktreeWorkerOperations> {
  return (
    isWorktreeRegistryReadCommand(command) ||
    command.type === "worktrees.retireMissing" ||
    command.type === "worktrees.deferCleanup" ||
    command.type === "worktrees.admitRunLease" ||
    command.type === "worktrees.releaseRunLease" ||
    command.type === "worktrees.reapRunLeases"
  );
}

export function executeWorktreeWorkerCommand(
  command: SqliteWorkerCommand<WorktreeWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): WorktreeWorkerOperations[keyof WorktreeWorkerOperations]["output"] {
  if (isWorktreeRegistryReadCommand(command)) {
    return executeWorktreeRegistryReadCommand(options.database.db, command);
  }
  if (command.type === "worktrees.retireMissing") {
    return retireMissingWorktreeInWorker(command.input, options);
  }
  if (command.type === "worktrees.deferCleanup") {
    return deferWorktreeCleanupInWorker(command.input, options);
  }
  return executeWorktreeRunLeaseCommand(command, options);
}
