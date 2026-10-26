import type { SqliteSourceFenceIdentity } from "../infra/sqlite-source-fence-contract.js";
import type {
  GitHubPublicationSourceFacts,
  GitHubPublicationSourceSelector,
  GitHubPublicationSessionFacts,
} from "./github-publication-source.types.js";

/** Memory metadata is supplied by its live host owner; durable sources stay worker-owned. */
export type GitHubPublicationSourceRead = { selector: GitHubPublicationSourceSelector } & (
  | {
      destination: SqliteSourceFenceIdentity;
      source: SqliteSourceFenceIdentity;
      memory?: never;
    }
  | { destination?: never; source?: never; memory: GitHubPublicationSessionFacts }
);

export type GitHubPublicationSourcePredicate = GitHubPublicationSourceRead & {
  expected: GitHubPublicationSourceFacts;
};

export type GitHubPublicationSourceOperations = {
  "githubPublication.sourceFacts": {
    input: { source: GitHubPublicationSourceRead };
    output: GitHubPublicationSourceFacts;
  };
};
