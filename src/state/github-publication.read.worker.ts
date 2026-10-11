import type { DatabaseSync } from "node:sqlite";
import {
  readPersonalGitHubPublicationInDatabase,
  listUnreportedPersonalGitHubPublicationsInDatabase,
} from "../gateway/github-personal-publication-store.js";
import {
  listGitHubPublicationsForClaimInDatabase,
  listSharedGitHubPublicationsInDatabase,
  readGitHubPublicationRequest,
} from "../gateway/github-publication-store.js";
import { readRepositoryGitHubPublicationBranchInDatabase } from "../gateway/github-repository-publication-store.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication.kernel.js";
import type { PublicationReadOperations } from "./github-publication-worker.types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const publicationReadOperations = {
  "githubPublications.sharedRead": (
    input: PublicationReadOperations["githubPublications.sharedRead"]["input"],
    db,
  ) => ({
    type: "githubPublications.sharedRead" as const,
    row: tableExists(db, "github_publication_requests")
      ? readGitHubPublicationRequest(db, input)
      : undefined,
  }),
  "githubPublications.sharedList": (
    input: PublicationReadOperations["githubPublications.sharedList"]["input"],
    db,
  ) => ({
    type: "githubPublications.sharedList" as const,
    rows: listSharedGitHubPublicationsInDatabase(db, input),
  }),
  "githubPublications.claimRequests": (
    input: PublicationReadOperations["githubPublications.claimRequests"]["input"],
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
  "githubPublications.branch": (
    input: Parameters<typeof readRepositoryGitHubPublicationBranchInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.branch" as const,
    branch: readRepositoryGitHubPublicationBranchInDatabase(db, input),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
