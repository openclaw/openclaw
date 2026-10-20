import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.types.js";
import type { GitHubPublicationChange } from "../gateway/github-publication-events.js";
import type { GitHubPublicationEffectTransition } from "../gateway/github-publication-execution-effects.js";
import type { WorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import type { GitHubPublicationRow } from "./github-publication-read.types.js";
import type { GitHubPublicationAuthorityReceipt } from "./github-publication-receipts.js";
import type { GitHubPublicationRequesterSnapshot } from "./github-publication-requester.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type SharedGitHubPublicationInsert = {
  request: {
    sessionKey: string;
    agentId: string;
    idempotencyKey: string;
    title?: string;
    body?: string;
    draft?: boolean;
  };
  requestId: string;
  requestDigest: string;
  sessionId: string;
  lifecycleRevision: string | null;
  requester: GitHubPublicationRequesterSnapshot;
  now: number;
  worktree: { id: string; repoFingerprint: string; branch: string };
  identity: Pick<PreparedGitHubPublicationIdentity, "source" | "profileId" | "account">;
  claim?: WorkerSessionTurnClaim;
  snapshot?: { sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string };
};
export type GitHubPublicationInsert =
  | { kind: "shared"; input: SharedGitHubPublicationInsert }
  | { kind: "personal"; row: PersonalPublicationRow; lifecycleRevision: string | null }
  | { kind: "repository"; row: RepositoryPublicationRow };
export type GitHubPublicationDeferral =
  | { kind: "claim"; claim: WorkerSessionTurnClaim }
  | { kind: "claimMissingSnapshot"; claim: WorkerSessionTurnClaim }
  | { kind: "request"; row: GitHubPublicationRow }
  | {
      kind: "orphaned";
      localClaims?: Pick<
        WorkerSessionTurnClaim,
        "sessionId" | "claimId" | "runId" | "placementGeneration"
      >[];
    };
export type SharedGitHubPublicationWorkspaceSnapshot = {
  row: GitHubPublicationRow;
  sourceHeadCommit: string;
  sourceIndexTree: string;
  workspaceTree: string;
};
export type SharedGitHubPublicationAcceptedSnapshot = SharedGitHubPublicationWorkspaceSnapshot & {
  claim: WorkerSessionTurnClaim;
};
export type SharedGitHubPublicationPublishingFacts = {
  row: GitHubPublicationRow;
  repository: string;
  branch: string;
  baseBranch: string;
  sourceHeadCommit: string;
  workspaceTree: string;
  headCommit: string;
};

export type PersonalPublicationSelector =
  | { requestId: string }
  | { sessionId: string; idempotencyKey: string }
  | { sessionKey: string; agentId: string };
export type PublicationReadOperations = import("./worker-operation-registry.js").WorkerOperations<
  typeof import("./github-publication.read.worker.js").publicationReadOperations
>;

type PersonalPublicationRow = DB["github_personal_publication_requests"];
type RepositoryPublicationRow = DB["github_repository_publication_requests"];
type Execution<Row> = { row: Row; instanceId: string; executionId: string };
type Mutation<Row> =
  | ({ operation: "claim" } & Execution<Row>)
  | (GitHubPublicationEffectTransition & Execution<Row>)
  | { operation: "report"; requestId: string };
export type PersonalPublicationMutation =
  | Mutation<PersonalPublicationRow>
  | { operation: "restart"; instanceId: string };
export type RepositoryPublicationMutation =
  | Mutation<RepositoryPublicationRow>
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
  | { operation: "defer"; selection: GitHubPublicationDeferral };

export type SharedPublicationMutation =
  | { operation: "bindAcceptedSnapshot"; input: SharedGitHubPublicationAcceptedSnapshot }
  | { operation: "report"; requestId: string }
  | { operation: "claim"; requestId: string; instanceId: string }
  | {
      operation: "bindWorkspaceSnapshot";
      instanceId: string;
      input: SharedGitHubPublicationWorkspaceSnapshot;
    }
  | {
      operation: "updatePublishingFacts";
      instanceId: string;
      input: SharedGitHubPublicationPublishingFacts;
    }
  | {
      operation: "complete";
      instanceId: string;
      row: GitHubPublicationRow;
      result: SessionGitHubPublicationResult;
    }
  | { operation: "defer"; selection: GitHubPublicationDeferral };

export type PublicationMaintenanceMutation =
  | { operation: "report"; requestId: string }
  | { operation: "deferClaim"; claim: WorkerSessionTurnClaim };

/** Postimages install only after the native destination COMMIT. */
export type PublicationMutationResult = {
  operationId: string;
  operation: string;
} & (
  | { kind: "shared"; rows: GitHubPublicationRow[] }
  | { kind: "personal"; rows: PersonalPublicationRow[] }
  | { kind: "repository"; rows: RepositoryPublicationRow[] }
  | { kind: "maintenance"; rows: [] }
);

export type PublicationMutationReceipt = PublicationMutationResult & {
  authority: GitHubPublicationAuthorityReceipt;
  changes: GitHubPublicationChange[];
};
