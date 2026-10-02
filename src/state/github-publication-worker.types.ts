import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { GitHubPublicationMutableFacts } from "../gateway/github-publication-execution-effects.js";
import type {
  RepositoryGitHubPublicationPendingQuery,
  RepositoryGitHubPublicationStatusRow,
  RepositoryGitHubPublicationFilter,
} from "../gateway/github-repository-publication.kernel.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type PersonalPublicationSelector =
  | { requestId: string }
  | { sessionId: string; idempotencyKey: string }
  | { sessionKey: string; agentId: string };
export type PublicationReadOperations = {
  "githubPublications.personalRead": {
    input: { owner: string; request: PersonalPublicationSelector };
    output: { type: "githubPublications.personalRead"; row: PersonalPublicationRow | undefined };
  };
  "githubPublications.unreported": {
    input: undefined;
    output: {
      type: "githubPublications.unreported";
      rows: {
        sessionId: string;
        sessionKey: string;
        agentId: string;
        result: SessionGitHubPublicationResult;
      }[];
    };
  };
  "githubPublications.repositoryList": {
    input: RepositoryGitHubPublicationFilter;
    output: { type: "githubPublications.repositoryList"; rows: RepositoryPublicationRow[] };
  };
  "githubPublications.branch": {
    input: { workspaceId: string; branch: string; pushRepository: string };
    output: {
      type: "githubPublications.branch";
      branch: { head: RepositoryPublicationRow | undefined; unsettled: boolean };
    };
  };
  "githubPublications.pending": {
    input: RepositoryGitHubPublicationPendingQuery;
    output: {
      type: "githubPublications.pending";
      row: RepositoryGitHubPublicationStatusRow | undefined;
    };
  };
};

type PersonalPublicationRow = DB["github_personal_publication_requests"];
type RepositoryPublicationRow = DB["github_repository_publication_requests"];
type Execution<Row> = { row: Row; instanceId: string; executionId: string };
type RecordFacts = GitHubPublicationMutableFacts & { pushed_head_commit?: string | null };
type Mutation<Row, Values = RecordFacts> =
  | ({ operation: "claim" } & Execution<Row>)
  | ({ operation: "record"; values: Values; requireAction: boolean } & Execution<Row>)
  | { operation: "report"; requestId: string };
export type PersonalPublicationMutation =
  | Mutation<PersonalPublicationRow, Omit<RecordFacts, "pushed_head_commit">>
  | { operation: "insert"; row: PersonalPublicationRow; lifecycleRevision: string | null }
  | { operation: "restart"; instanceId: string };
export type RepositoryPublicationMutation =
  | Mutation<RepositoryPublicationRow>
  | { operation: "insert"; row: RepositoryPublicationRow }
  | {
      operation: "checkpoint";
      row: RepositoryPublicationRow;
      checkpoint: Pick<
        RepositoryPublicationRow,
        | "checkpoint_ref"
        | "checkpoint_digest"
        | "source_head_commit"
        | "source_index_tree"
        | "workspace_tree"
      >;
    }
  | { operation: "failPreparation"; row: RepositoryPublicationRow; nextAction: string }
  | { operation: "retire"; row: RepositoryPublicationRow }
  | { operation: "defer"; requestIds: readonly string[] };

/** Transient settlement evidence; runtime authority remains with PR3's owning episode. */
export type PublicationMutationReceipt = {
  operationId: string;
  operation: string;
} & (
  | { kind: "personal"; rows: PersonalPublicationRow[] }
  | { kind: "repository"; rows: RepositoryPublicationRow[] }
);
