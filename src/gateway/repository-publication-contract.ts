import type { ControlUiSessionPullRequest } from "../../packages/gateway-protocol/src/control-ui-session-pull-requests.js";
import type {
  SessionGitHubPullRequestInspectResult,
  SessionGitHubOptionsResult,
  SessionGitHubActionParams,
  SessionGitHubActionResult,
  SessionGitHubPublicationPublished,
  SessionGitHubPublicationResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PersonalGitHubStatus } from "../../packages/gateway-protocol/src/schema/users.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import type { GitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { RepositoryPublicationContentHostV1 } from "./repository-publication-content-contract.js";
import type { RepositoryPublicationFailure } from "./repository-publication-errors.js";
import type { RepositoryPublicationGitTransfer } from "./repository-publication-git-transfer.js";
import type { RepositoryPublicationOwnPullRequestReader } from "./repository-session-read.types.js";
import type { RepositoryWorkerIdentityTransfer } from "./repository-worker-identity-transfer.js";

export type { RepositoryPublicationOwnPullRequestReader } from "./repository-session-read.types.js";

/** Facts required by the existing native GitHub receipt backend; never credential authority. */
export type NativeGitHubPublisherProvenance = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  account: Readonly<{ accountId: number; login: string }>;
}>;
type RepositoryPublicationAuthor = { name: string; email: string };
export type RepositoryPublicationPublisher = {
  provenance: NativeGitHubPublisherProvenance;
  author: RepositoryPublicationAuthor;
  assertCurrent(this: void): void;
  /** The account owner refreshes its own credentials, preserving the accepted selection. */
  refresh(this: void): Promise<void>;
  /** Credentials are consumed only by this one-use host-bound Git operation. */
  authorizeGit(this: void, transfer: RepositoryPublicationGitTransfer): Promise<void>;
};
type RepositoryPublicationPublishedPullRequest = {
  url: string;
  number: number;
  pushRepository: string;
};
export type RepositoryPublicationTarget = {
  publishedPullRequest?: RepositoryPublicationPublishedPullRequest;
  pullRequest?: SessionGitHubPullRequestBinding;
  pushRepository: string;
  repository: string;
  branch: string;
  baseBranch: string;
  remoteUrl: string;
  baseRemoteUrl: string;
};
export type RepositoryPublicationRequestFacts = {
  requestId: string;
  createdAtMs: number;
  session: PublicationSessionIdentity;
  title?: string;
  body?: string;
  draft: boolean;
  publisher: NativeGitHubPublisherProvenance;
};
/** Immutable normalized objects; the host keeps checkpoint locations and custody private. */
export type RepositoryPublicationSnapshot = {
  version: 1;
  baseCommit: string;
  baseTree: string;
  workspaceTree: string;
  entries: readonly {
    path: string;
    mode: "100644" | "100755" | "120000" | "160000";
    sha: string | null;
  }[];
  readBlob(this: void, sha: string): Promise<Buffer>;
};
export type RepositoryPublicationContent = {
  title: string;
  commitMessage: string;
  trailers: readonly string[];
  assertCurrent(this: void): void;
  pullRequestBody(this: void): string;
};
export type RepositoryPublicationRemoteFacts = {
  target: RepositoryPublicationTarget;
  request: RepositoryPublicationRequestFacts;
  publisher: RepositoryPublicationPublisher;
  headCommit: string;
  workspaceTree: string;
  parentCommit: string;
};
export type { RepositoryPublicationFailure } from "./repository-publication-errors.js";

export type RepositoryPublicationPersonalAction = {
  owner: string;
  assertCurrent: () => void;
};
export type RepositoryPublicationPersonalSessionAction = RepositoryPublicationPersonalAction &
  PublicationSessionIdentity &
  Pick<GitHubPublicationRequesterV2, "version" | "signal" | "prepareSource"> & {
    lifecycleRevision: string | null;
  };
export type RepositoryPublicationPersonalBinding = {
  provenance: NativeGitHubPublisherProvenance;
  generation: string;
  assertCurrent(this: void): void;
  prepare(this: void, assertWorkspace: () => void): Promise<RepositoryPublicationPublisher>;
};

export type RepositoryPublicationObjectPlan = {
  request: RepositoryPublicationRequestFacts;
  target: RepositoryPublicationTarget;
  publisher: RepositoryPublicationPublisher;
  snapshot: RepositoryPublicationSnapshot;
  previousHeadCommit: string | null;
  headCommit: string | null;
  contentHost: RepositoryPublicationContentHostV1;
  assertCurrent(this: void): void;
  assertWorkflowChangesAllowed(this: void): void;
  prepareCommit(this: void, headCommit: string): Promise<void>;
  effects: {
    record(
      this: void,
      kind: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): Promise<void>;
  };
};

export type RepositoryWorkerIdentity = {
  readonly signal: AbortSignal;
  assertCurrent(this: void): void;
  refresh(this: void, assertCurrent: () => void): Promise<"ready" | "retired">;
  subscribe(this: void, listener: (change: "changed" | "retired") => void): () => void;
  deliver(this: void, transfer: RepositoryWorkerIdentityTransfer): Promise<void>;
};

export type RepositoryPublicationActionResult = Omit<
  SessionGitHubActionResult,
  "publishingSessionKey"
>;

/** Fixed host-authorized target and narrow custody operations; no credentials or stores cross. */
export type RepositoryPublicationActionInput = {
  params: Exclude<
    SessionGitHubActionParams,
    { action: "refresh_base" | "inspect_pr" | "prepare_pr" }
  >;
  agentId: string;
  binding?: SessionGitHubPullRequestBinding;
  publication?: SessionGitHubPublicationPublished;
  pullRequest: Pick<SessionGitHubPublicationPublished, "url" | "repository" | "branch">;
  fullWrite: boolean;
  /** Required for a non-operator request against its original bound PR. */
  reader?: RepositoryPublicationOwnPullRequestReader;
  signal: AbortSignal;
  assertCurrent(this: void): void;
  assertPublicationCurrent(this: void): Promise<void>;
  readEvidence(this: void): Promise<{
    data: Uint8Array;
    filename: string;
    mimeType: string;
    sha256: string;
    sizeBytes: number;
  }>;
  prepareMergeAttribution(
    this: void,
    excludeAccountId: number,
  ): Promise<{
    attribution: { trailers: string[]; logins: string[] } | undefined;
    isCurrent(this: void): boolean;
  }>;
};

/** Vendor policy and remote transport. No stores, rows, placement owners, or session projections. */
export type RepositoryPublicationProvider = {
  id: string;
  /** Readiness hint only; publication prepares its target again before effects. */
  supportsOrigin(this: void, originUrl: string): boolean;
  assertCurrent(this: void): void;
  formatReport(
    this: void,
    result: SessionGitHubPublicationResult,
  ): { text: string; responseId: string };
  resolveGitAuthor?(this: void, agentId: string): { name?: string; email?: string } | undefined;
  prepareWorkerIdentity?(
    this: void,
    input: { agentId: string; originUrl: string; assertCurrent(this: void): void },
  ): Promise<RepositoryWorkerIdentity | undefined>;
  subscribeWorkerIdentityChanges?(this: void, listener: () => void): () => void;
  preparePublisher(
    this: void,
    agentId: string,
    expected?: NativeGitHubPublisherProvenance,
  ): Promise<RepositoryPublicationPublisher>;
  bindPersonal(
    this: void,
    input: {
      action: Pick<
        RepositoryPublicationPersonalSessionAction,
        "owner" | "agentId" | "assertCurrent"
      >;
      selected: { generation: string; account: { accountId: number; login: string } };
      preparation?: { idempotencyKey: string; hasRequest: () => boolean };
    },
  ): Promise<RepositoryPublicationPersonalBinding>;
  /** Display-only account facts; the provider retains all authentication state. */
  readOptionsIdentity(
    this: void,
    input: { agentId: string; assertCurrent(this: void): void },
  ): Promise<{
    identity: {
      source: NonNullable<SessionGitHubOptionsResult["shared"]>["source"];
      host: string | undefined;
      account: { accountId: number; login: string };
      stale?: true;
    } | null;
    unavailableReason?: SessionGitHubOptionsResult["sharedUnavailableReason"];
  }>;
  /** The returned assertion retains this exact account-status read, not a later selection. */
  preparePersonalAccountStatus(
    this: void,
    action: RepositoryPublicationPersonalAction,
  ): Promise<{ status: PersonalGitHubStatus; assertCurrent(this: void): void }>;
  isPublicationSuperseded(
    this: void,
    snapshot: {
      repository: string | null;
      branch: string;
      sourceHeadCommit: string | null;
      workspaceTree: string | null;
    },
    readPublished: () => Promise<
      { pullRequests: readonly ControlUiSessionPullRequest[]; assertCurrent(): void } | undefined
    >,
  ): Promise<boolean>;
  readPersonalSelection(
    this: void,
    action: RepositoryPublicationPersonalAction,
  ): Promise<{ generation: string | null; provenance: NativeGitHubPublisherProvenance | null }>;
  performPullRequestAction(
    this: void,
    input: RepositoryPublicationActionInput,
  ): Promise<RepositoryPublicationActionResult>;
  inspectPullRequest(
    this: void,
    input: {
      pullRequestUrl: string;
      agentId: string;
      reader: RepositoryPublicationOwnPullRequestReader;
      assertCurrent(this: void): void;
    },
  ): Promise<{
    result: SessionGitHubPullRequestInspectResult;
    ownPublication: boolean;
    publishedHeadCommit?: string;
    assertCurrent(this: void): void;
    assertSource(this: void, originUrl: string): void;
    verifyWriteAccess(this: void): Promise<void>;
  }>;
  prepareBoundPublication(
    this: void,
    input: {
      pullRequest: SessionGitHubPullRequestBinding;
      expectedHead: string;
      journaledHead: string | null;
      sourceHead: string | null;
      agentId: string;
      reader: RepositoryPublicationOwnPullRequestReader;
      publisher: RepositoryPublicationPublisher;
      assertCurrent(this: void): void;
    },
  ): Promise<{
    observedPublication: boolean;
    assertCurrent(this: void): void;
    refresh(this: void): Promise<boolean>;
  }>;
  prepareTarget(
    this: void,
    input: {
      repositoryOnly?: boolean;
      /** Observe the accepted destination without discovering fresh publication eligibility. */
      recorded?: Pick<RepositoryPublicationTarget, "pushRepository" | "repository" | "baseBranch">;
      pullRequest?: SessionGitHubPullRequestBinding;
      originUrl: string;
      branch: string;
      baseRef: string;
      publisher: RepositoryPublicationPublisher;
      assertCurrent(this: void): void;
    },
  ): Promise<RepositoryPublicationTarget>;
  preparePublishedTarget(
    this: void,
    input: {
      target: RepositoryPublicationTarget;
      publisher: RepositoryPublicationPublisher;
      publishedPullRequest: RepositoryPublicationPublishedPullRequest;
      publisherAccountId?: number;
      reconcile?: boolean;
      assertCurrent(this: void): void;
    },
  ): Promise<RepositoryPublicationTarget>;
  readBase(
    this: void,
    input: {
      target: RepositoryPublicationTarget;
      publisher: RepositoryPublicationPublisher;
      assertCurrent(this: void): void;
    },
  ): Promise<string>;
  observeBranch(
    this: void,
    input: {
      target: RepositoryPublicationTarget;
      publisher: RepositoryPublicationPublisher;
      assertCurrent(this: void): void;
    },
  ): Promise<string | null>;
  findPullRequest(
    this: void,
    input: RepositoryPublicationRemoteFacts & {
      assertCurrent(this: void): void;
      recordObserved(this: void, url: string): Promise<void>;
    },
  ): Promise<string | undefined>;
  createPullRequest(
    this: void,
    input: RepositoryPublicationRemoteFacts & {
      content: RepositoryPublicationContent;
      assertCurrent(this: void): void;
    },
  ): Promise<string | undefined>;
  reconcile(
    this: void,
    input: RepositoryPublicationRemoteFacts & {
      knownPullRequestUrls: readonly string[];
      beforeRetry?: boolean;
      readContinuation?: (
        this: void,
      ) => Promise<
        Pick<RepositoryPublicationTarget, "publishedPullRequest" | "baseBranch"> | undefined
      >;
      pushOnly?: "observed" | "dispatched";
      assertCurrent(this: void): void;
      recordObserved(this: void, url: string): Promise<void>;
      recordPushObserved?(this: void, headCommit: string): Promise<void>;
    },
  ): Promise<string | undefined>;
  formatContent(
    this: void,
    input: {
      request: RepositoryPublicationRequestFacts;
      target: RepositoryPublicationTarget;
      publisher: RepositoryPublicationPublisher;
      host: RepositoryPublicationContentHostV1;
      description: string;
    },
  ): Promise<RepositoryPublicationContent>;
  prepareChangeGuard(
    this: void,
    input: {
      assertPermission(this: void): void;
      readTree(
        this: void,
        role: "before" | "accepted" | "ancestor" | "target",
      ): Promise<Buffer | undefined>;
    },
  ): Promise<() => void>;
  executeRepository(
    this: void,
    input: RepositoryPublicationObjectPlan,
  ): Promise<{ url: string; headCommit: string }>;
  resolveFailure(this: void, error: unknown): RepositoryPublicationFailure;
  isDefinitiveFailure(this: void, error: unknown): boolean;
};
