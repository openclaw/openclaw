import * as personal from "../gateway/github-personal-publication-store.js";
import * as repository from "../gateway/github-repository-publication-store.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication.kernel.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type {
  PersonalPublicationMutation,
  RepositoryPublicationMutation,
  PublicationMutationReceipt,
} from "./github-publication-worker.types.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

const admitted = () => {};
const authority = { assertCurrent: admitted, assertCustody: admitted };

function mutate(
  database: OpenClawStateDatabase,
  operation: string,
  write: () => PublicationMutationReceipt,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: { operation } });
      const receipt = write();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: `github-publication.${operation}` },
  );
}

function personalMutation(database: OpenClawStateDatabase, input: PersonalPublicationMutation) {
  switch (input.operation) {
    case "insert":
      return [
        personal.insertPersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.lifecycleRevision,
          admitted,
        ),
      ];
    case "claim":
      return [
        personal.claimPersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          admitted,
        ),
      ];
    case "record":
      return [
        personal.writePersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          input.values,
          input.requireAction,
          admitted,
        ),
      ];
    case "restart":
      return personal.requirePersonalGitHubPublicationConfirmationInDatabase(
        database,
        input.instanceId,
      );
    case "report": {
      const row = personal.markPersonalGitHubPublicationReportedInDatabase(
        database,
        input.requestId,
      );
      return row ? [row] : [];
    }
  }
  throw new Error("Unknown personal GitHub publication mutation.");
}

function repositoryMutation(database: OpenClawStateDatabase, input: RepositoryPublicationMutation) {
  switch (input.operation) {
    case "insert":
      return [
        repository.insertRepositoryGitHubPublicationInDatabase(database, input.row, admitted),
      ];
    case "claim":
      return [
        repository.claimRepositoryGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          authority,
        ),
      ];
    case "record":
      return [
        repository.writeRepositoryGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          input.values,
          input.requireAction,
          authority,
        ),
      ];
    case "checkpoint":
      return [
        repository.bindRepositoryGitHubPublicationCheckpointInDatabase(
          database,
          input.row,
          input.checkpoint,
          admitted,
        ),
      ];
    case "failPreparation":
      return [
        repository.failRepositoryGitHubPublicationPreparationInDatabase(
          database,
          input.row,
          input.nextAction,
          admitted,
        ),
      ];
    case "defer":
      return repository.deferRepositoryGitHubPublicationClaimsInDatabase(
        database,
        input.requestIds,
      );
    case "retire": {
      // The host grants this command only while its original session is no longer current.
      const row = repository.failStaleRepositoryGitHubPublicationInDatabase(
        database,
        input.row,
        () => false,
      );
      return row ? [row] : [];
    }
    case "report": {
      const row = repository.markRepositoryGitHubPublicationReportedInDatabase(
        database,
        input.requestId,
      );
      return row ? [row] : [];
    }
  }
  throw new Error("Unknown repository GitHub publication mutation.");
}

export const publicationOperations = {
  "githubPublications.personal": (
    input: PersonalPublicationMutation & { operationId: string },
    { open },
  ) => {
    const database = open();
    return mutate(database, input.operation, () => ({
      operationId: input.operationId,
      operation: input.operation,
      kind: "personal",
      rows: personalMutation(database, input),
    }));
  },
  "githubPublications.repository": (
    input: RepositoryPublicationMutation & { operationId: string },
    { open },
  ) => {
    const database = open();
    return mutate(database, input.operation, () => ({
      operationId: input.operationId,
      operation: input.operation,
      kind: "repository",
      rows: repositoryMutation(database, input),
    }));
  },
  "githubPublications.prepareRepository": (
    input: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1],
    { open },
  ) => listRepositoryGitHubPublicationsInDatabase(open().db, input),
  "githubPublications.preparePersonal": (
    input: {
      owner: string;
      request: Parameters<typeof personal.readPersonalGitHubPublicationInDatabase>[2];
    },
    { open },
  ) => personal.readPersonalGitHubPublicationInDatabase(open().db, input.owner, input.request),
} satisfies WorkerOperationHandlers;
