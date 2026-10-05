import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
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
  discardSessionRepositoryWorkspaceCheckpointInDatabase,
  advanceSessionRepositoryWorkspaceToPublishedHeadInDatabase,
  findSessionRepositoryWorkspaceInDatabase,
  readSessionRepositoryWorkspaceInDatabase,
} from "./session-repository-workspaces.kernel.js";
import type {
  RepositoryWorkspaceBase,
  RepositoryWorkspaceCheckpoint,
  RepositoryWorkspaceCreate,
  RepositoryWorkspaceMutation,
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceOwner,
} from "./session-repository-workspaces.types.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const repositoryWorkspaceOperations = {
  "repositoryWorkspaces.get": (input: { workspaceId: string }, { open }) =>
    readSessionRepositoryWorkspaceInDatabase(open().db, input.workspaceId),
  "repositoryWorkspaces.find": (input: RepositoryWorkspaceOwner, { open }) =>
    findSessionRepositoryWorkspaceInDatabase(open().db, input),
  "repositoryWorkspaces.create": (
    input: RepositoryWorkspaceCreate & { nowMs?: number },
    { open },
  ) =>
    mutate(open(), "repositoryWorkspaces.create", (db) =>
      createSessionRepositoryWorkspaceInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.bindBase": (
    input: RepositoryWorkspaceBase & { nowMs?: number },
    { open },
  ) =>
    mutate(open(), "repositoryWorkspaces.bindBase", (db) =>
      bindSessionRepositoryWorkspaceBaseInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.acceptCheckpoint": (
    input: RepositoryWorkspaceCheckpoint & { nowMs?: number },
    { open },
  ) =>
    mutate(open(), "repositoryWorkspaces.acceptCheckpoint", (db) =>
      acceptSessionRepositoryWorkspaceCheckpointInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.discardCheckpoint": (
    input: RepositoryWorkspaceMutation & { nowMs?: number },
    { open },
  ) =>
    mutate(open(), "repositoryWorkspaces.discardCheckpoint", (db) =>
      discardSessionRepositoryWorkspaceCheckpointInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.advanceToPublishedHead": (
    input: RepositoryWorkspaceMutation & { branch: string; headCommit: string; nowMs?: number },
    { open },
  ) =>
    mutate(open(), "repositoryWorkspaces.advanceToPublishedHead", (db) =>
      advanceSessionRepositoryWorkspaceToPublishedHeadInDatabase(
        db,
        input,
        input.nowMs ?? Date.now(),
      ),
    ),
  "repositoryWorkspaces.delete": (
    input: { workspaceId: string; sessionEntryCurrentSource?: SessionEntryCurrentSource },
    { open },
  ) =>
    mutate(
      open(),
      "repositoryWorkspaces.delete",
      (db) => deleteSessionRepositoryWorkspaceInDatabase(db, input.workspaceId),
      input.sessionEntryCurrentSource,
    ),
} satisfies WorkerOperationHandlers;

function mutate(
  database: OpenClawStateDatabase,
  operationLabel: string,
  operation: (db: OpenClawStateDatabase["db"]) => RepositoryWorkspaceMutationResult,
  sessionEntryCurrentSource?: SessionEntryCurrentSource,
): RepositoryWorkspaceMutationResult {
  const admit = (stage: "transaction" | "commit", facts: unknown) =>
    requestSessionEntryCurrentAdmission(
      sessionEntryCurrentSource,
      { stage, facts },
      { lookup: "logical" },
    );
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      admit("transaction", undefined);
      const result = operation(db);
      admit("commit", result);
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { database },
    { operationLabel },
  );
}
