import type { DatabaseSync } from "node:sqlite";
import {
  readPersonalGitHubPublicationInDatabase,
  listUnreportedPersonalGitHubPublicationsInDatabase,
} from "../gateway/github-personal-publication-store.js";
import { readRepositoryGitHubPublicationBranchInDatabase } from "../gateway/github-repository-publication-store.js";
import {
  listRepositoryGitHubPublicationsInDatabase,
  readPendingRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication.kernel.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export const publicationReadOperations = {
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
  "githubPublications.pending": (
    input: Parameters<typeof readPendingRepositoryGitHubPublicationInDatabase>[1],
    db,
  ) => ({
    type: "githubPublications.pending" as const,
    row: readPendingRepositoryGitHubPublicationInDatabase(db, input),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
