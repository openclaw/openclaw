import type { GitHubPublicationSourcePredicate } from "./github-publication-source-contract.js";
import type {
  GitHubPublicationInsert,
  PersonalPublicationMutation,
  PublicationMaintenanceMutation,
  RepositoryPublicationMutation,
  SharedPublicationMutation,
} from "./github-publication-worker.types.js";

type MutationInput<Input> = Input & {
  operationId: string;
  source?: GitHubPublicationSourcePredicate;
};

/** Results arrive through native commit receipts, independently of ordinary replies. */
export type PublicationWorkerOperations = {
  "githubPublications.maintenance": {
    input: PublicationMaintenanceMutation & { operationId: string };
    output: void;
  };
  "githubPublications.insert": {
    input: GitHubPublicationInsert & {
      operation: "insert";
      operationId: string;
      source: GitHubPublicationSourcePredicate;
    };
    output: void;
  };
  "githubPublications.shared": {
    input: MutationInput<SharedPublicationMutation>;
    output: void;
  };
  "githubPublications.personal": {
    input: MutationInput<PersonalPublicationMutation>;
    output: void;
  };
  "githubPublications.repository": {
    input: MutationInput<RepositoryPublicationMutation>;
    output: void;
  };
};
