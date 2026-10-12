import type { SqliteSourceFenceIdentity } from "../infra/sqlite-source-fence-contract.js";
import type {
  GitHubPublicationSourceFacts,
  GitHubPublicationSourceSelector,
} from "./github-publication-source.types.js";

/** Physical owners and exact prepared predicates, never host callbacks. */
export type GitHubPublicationSourcePredicate = {
  destination: SqliteSourceFenceIdentity;
  source: SqliteSourceFenceIdentity;
  selector: GitHubPublicationSourceSelector;
  expected: GitHubPublicationSourceFacts;
};

export type GitHubPublicationSourceRead = Omit<GitHubPublicationSourcePredicate, "expected">;

export type GitHubPublicationSourceOperations = {
  "githubPublication.sourceFacts": {
    input: { source: GitHubPublicationSourceRead };
    output: GitHubPublicationSourceFacts;
  };
};
