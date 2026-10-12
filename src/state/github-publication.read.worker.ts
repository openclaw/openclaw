import {
  readPersonalGitHubPublicationInDatabase,
  listUnreportedPersonalGitHubPublicationsInDatabase,
} from "../gateway/github-personal-publication-store.js";
import {
  listGitHubPublicationsForClaimInDatabase,
  listSharedGitHubPublicationsInDatabase,
  readGitHubPublicationRequest,
} from "../gateway/github-publication-store.js";
import {
  readRepositoryGitHubPublicationBranchInDatabase,
  readRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../gateway/github-repository-publication.kernel.js";
import type { PublicationReadOperations } from "./github-publication-worker.types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const publicationReadOperations = {
  "githubPublications.sharedRead": (
    input: PublicationReadOperations["githubPublications.sharedRead"]["input"],
    { open },
  ) => {
    const { db } = open();
    return {
      type: "githubPublications.sharedRead" as const,
      row: tableExists(db, "github_publication_requests")
        ? readGitHubPublicationRequest(db, input)
        : undefined,
    };
  },
  "githubPublications.sharedList": (
    input: PublicationReadOperations["githubPublications.sharedList"]["input"],
    { open },
  ) => ({
    type: "githubPublications.sharedList" as const,
    rows: listSharedGitHubPublicationsInDatabase(open().db, input),
  }),
  "githubPublications.claimRequests": (
    input: PublicationReadOperations["githubPublications.claimRequests"]["input"],
    { open },
  ) => ({
    type: "githubPublications.claimRequests" as const,
    rows: listGitHubPublicationsForClaimInDatabase(open().db, input.claim, input),
  }),
  "githubPublications.personalRead": (
    input: {
      owner: string;
      request: Parameters<typeof readPersonalGitHubPublicationInDatabase>[2];
    },
    { open },
  ) => ({
    type: "githubPublications.personalRead" as const,
    row: readPersonalGitHubPublicationInDatabase(open().db, input.owner, input.request),
  }),
  "githubPublications.unreported": (_input: undefined, { open }) => ({
    type: "githubPublications.unreported" as const,
    rows: listUnreportedPersonalGitHubPublicationsInDatabase(open().db),
  }),
  "githubPublications.repositoryList": (
    input: Parameters<typeof listRepositoryGitHubPublicationsInDatabase>[1],
    { open },
  ) => ({
    type: "githubPublications.repositoryList" as const,
    rows: listRepositoryGitHubPublicationsInDatabase(open().db, input),
  }),
  "githubPublications.repositoryRead": ({ requestId }: { requestId: string }, { open }) => ({
    type: "githubPublications.repositoryRead" as const,
    row: readRepositoryGitHubPublicationInDatabase(open().db, requestId),
  }),
  "githubPublications.branch": (
    input: Parameters<typeof readRepositoryGitHubPublicationBranchInDatabase>[1],
    { open },
  ) => ({
    type: "githubPublications.branch" as const,
    branch: readRepositoryGitHubPublicationBranchInDatabase(open().db, input),
  }),
} satisfies WorkerOperationHandlers;
