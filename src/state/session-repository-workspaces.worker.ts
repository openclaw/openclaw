import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  acceptSessionRepositoryWorkspaceCheckpointInDatabase,
  bindSessionRepositoryWorkspaceBaseInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
  deleteSessionRepositoryWorkspaceInDatabase,
  findSessionRepositoryWorkspaceInDatabase,
  readSessionRepositoryWorkspaceInDatabase,
} from "./session-repository-workspaces.kernel.js";
import type {
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceWorkerOperations,
} from "./session-repository-workspaces.types.js";

type Command = SqliteWorkerCommand<RepositoryWorkspaceWorkerOperations>;

export function isRepositoryWorkspaceCommand(command: { type: string }): command is Command {
  return (
    command.type === "repositoryWorkspaces.get" ||
    command.type === "repositoryWorkspaces.find" ||
    command.type === "repositoryWorkspaces.create" ||
    command.type === "repositoryWorkspaces.bindBase" ||
    command.type === "repositoryWorkspaces.acceptCheckpoint" ||
    command.type === "repositoryWorkspaces.delete"
  );
}

export function executeRepositoryWorkspaceCommand(
  command: Command,
  database: OpenClawStateDatabase,
): RepositoryWorkspaceWorkerOperations[keyof RepositoryWorkspaceWorkerOperations]["output"] {
  if (command.type === "repositoryWorkspaces.get") {
    return readSessionRepositoryWorkspaceInDatabase(database.db, command.input.workspaceId);
  }
  if (command.type === "repositoryWorkspaces.find") {
    return findSessionRepositoryWorkspaceInDatabase(database.db, command.input);
  }
  const sessionEntryCurrentSource =
    command.type === "repositoryWorkspaces.delete"
      ? command.input.sessionEntryCurrentSource
      : undefined;
  const admit = (stage: "transaction" | "commit", facts: unknown) =>
    requestSessionEntryCurrentAdmission(
      sessionEntryCurrentSource,
      { stage, facts },
      { lookup: "logical" },
    );
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      admit("transaction", undefined);
      let result: RepositoryWorkspaceMutationResult;
      switch (command.type) {
        case "repositoryWorkspaces.create":
          result = createSessionRepositoryWorkspaceInDatabase(
            db,
            command.input,
            command.input.nowMs ?? Date.now(),
          );
          break;
        case "repositoryWorkspaces.bindBase":
          result = bindSessionRepositoryWorkspaceBaseInDatabase(
            db,
            command.input,
            command.input.nowMs ?? Date.now(),
          );
          break;
        case "repositoryWorkspaces.acceptCheckpoint":
          result = acceptSessionRepositoryWorkspaceCheckpointInDatabase(
            db,
            command.input,
            command.input.nowMs ?? Date.now(),
          );
          break;
        case "repositoryWorkspaces.delete":
          result = deleteSessionRepositoryWorkspaceInDatabase(db, command.input.workspaceId);
          break;
      }
      admit("commit", result);
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { database },
    { operationLabel: command.type },
  );
}
