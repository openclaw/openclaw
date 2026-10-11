import type { GitHubPublicationSourcePredicate } from "./github-publication-source-contract.js";
import type {
  GitHubPublicationInsert,
  PersonalPublicationMutation,
  PublicationMaintenanceMutation,
  PublicationMutationReceipt,
  PublicationReadOperations,
  RepositoryPublicationMutation,
  SharedPublicationMutation,
} from "./github-publication-worker.types.js";

type MutationInput<Input> = Input & {
  operationId: string;
  source?: GitHubPublicationSourcePredicate;
};

export type PublicationWorkerOperations = PublicationReadOperations & {
  "githubPublications.maintenance": {
    input: PublicationMaintenanceMutation & { operationId: string };
    output: PublicationMutationReceipt;
  };
  "githubPublications.insert": {
    input: GitHubPublicationInsert & {
      operation: "insert";
      operationId: string;
      source: GitHubPublicationSourcePredicate;
    };
    output: PublicationMutationReceipt;
  };
  "githubPublications.shared": {
    input: MutationInput<SharedPublicationMutation>;
    output: PublicationMutationReceipt;
  };
  "githubPublications.personal": {
    input: MutationInput<PersonalPublicationMutation>;
    output: PublicationMutationReceipt;
  };
  "githubPublications.repository": {
    input: MutationInput<RepositoryPublicationMutation>;
    output: PublicationMutationReceipt;
  };
};
