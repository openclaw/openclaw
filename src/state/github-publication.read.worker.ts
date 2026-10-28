import {
  readPersonalGitHubPublicationInDatabase,
  listUnreportedPersonalGitHubPublicationsInDatabase,
} from "../gateway/github-personal-publication-store.worker.js";
import {
  readSharedGitHubPublicationRequestInDatabase,
  readSharedRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-publication-shared-read.kernel.js";
import {
  listGitHubPublicationsForClaimInDatabase,
  listSharedGitHubPublicationsInDatabase,
  readGitHubPublicationRequest,
} from "../gateway/github-publication-store.worker.js";
import {
  listRepositoryGitHubPublicationsInDatabase,
  readPendingRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-read.worker.js";
import {
  readRepositoryGitHubPublicationBranchInDatabase,
  readRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.worker.js";
import {
  readPersonalGitLabPublicationInDatabase,
  readSharedGitLabPublicationInDatabase,
  listUnreportedPersonalGitLabPublicationsInDatabase,
} from "../gateway/gitlab-personal-publication-store.worker.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SharedGitHubPublicationReadInput } from "./github-publication-read.types.js";
import {
  readTaskPublicationReceipts,
  type TaskPublicationRead,
} from "./github-publication-task-reads.worker.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const publicationReadOperations = {
  "githubPublications.sharedObservation": (
    { session, selector, entry }: SharedGitHubPublicationReadInput,
    db,
  ) => ({
    type: "githubPublications.sharedObservation" as const,
    row:
      readSharedRepositoryGitHubPublicationInDatabase(db, session, selector, entry) ??
      readSharedGitHubPublicationRequestInDatabase(db, session, selector, entry),
  }),
  "githubPublications.taskReceipts": (input: TaskPublicationRead, db) => ({
    type: "githubPublications.taskReceipts" as const,
    result: readTaskPublicationReceipts(db, input),
  }),
  "githubPublications.sharedRead": (
    input: Parameters<typeof readGitHubPublicationRequest>[1],
    db,
  ) => {
    return {
      type: "githubPublications.sharedRead" as const,
      row: tableExists(db, "github_publication_requests")
        ? readGitHubPublicationRequest(db, input)
        : undefined,
    };
  },
  "githubPublications.sharedList": (
    input: Parameters<typeof listSharedGitHubPublicationsInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.sharedList" as const,
    rows: listSharedGitHubPublicationsInDatabase(db, input),
  }),
  "githubPublications.claimRequests": (
    input: {
      claim: Parameters<typeof listGitHubPublicationsForClaimInDatabase>[1];
      pendingOnly?: boolean;
    },
    db,
  ) => ({
    type: "githubPublications.claimRequests" as const,
    rows: listGitHubPublicationsForClaimInDatabase(db, input.claim, input),
  }),
  "githubPublications.personalRead": (
    input: {
      owner: string;
      request: Parameters<typeof readPersonalGitHubPublicationInDatabase>[2];
    },
    db,
  ) => ({
    type: "githubPublications.personalRead" as const,
    row: readPersonalGitHubPublicationInDatabase(db, input.owner, input.request),
  }),
  "githubPublications.gitlabPersonalRead": (
    input: {
      owner: string;
      issuer: string;
      request: Parameters<typeof readPersonalGitLabPublicationInDatabase>[3];
    },
    db,
  ) => ({
    type: "githubPublications.gitlabPersonalRead" as const,
    row: readPersonalGitLabPublicationInDatabase(db, input.owner, input.issuer, input.request),
  }),
  "githubPublications.gitlabSharedRead": (
    input: Parameters<typeof readSharedGitLabPublicationInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.gitlabSharedRead" as const,
    row: readSharedGitLabPublicationInDatabase(db, input),
  }),
  "githubPublications.gitlabPersonalUnreported": (_input: undefined, db) => ({
    type: "githubPublications.gitlabPersonalUnreported" as const,
    rows: listUnreportedPersonalGitLabPublicationsInDatabase(db),
  }),
  "githubPublications.unreported": (_input: undefined, db) => ({
    type: "githubPublications.unreported" as const,
    rows: listUnreportedPersonalGitHubPublicationsInDatabase(db),
  }),
  "githubPublications.repositoryList": (
    input: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.repositoryList" as const,
    rows: listRepositoryGitHubPublicationsInDatabase(db, input),
  }),
  "githubPublications.repositoryRead": ({ requestId }: { requestId: string }, db) => ({
    type: "githubPublications.repositoryRead" as const,
    row: readRepositoryGitHubPublicationInDatabase(db, requestId),
  }),
  "githubPublications.branch": (
    input: Parameters<typeof readRepositoryGitHubPublicationBranchInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.branch" as const,
    branch: readRepositoryGitHubPublicationBranchInDatabase(db, input),
  }),
  "githubPublications.personalPending": (
    input: Parameters<typeof readPendingRepositoryGitHubPublicationInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.personalPending" as const,
    row: readPendingRepositoryGitHubPublicationInDatabase(db, input),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
