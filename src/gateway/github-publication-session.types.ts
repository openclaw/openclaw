import type {
  GitHubPublicationPublisher,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type {
  GitHubPublicationRequester,
  GitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-store.js";

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
export type PublicationSessionRead = Pick<
  Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
  "agentId" | "canonicalKey" | "storePath" | "entry"
>;

/** @deprecated Use GitHubPublicationClaimRequestV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationClaimRequest = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  agentId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
  draft?: boolean;
  requester: GitHubPublicationRequester;
  expectedPublisher?: GitHubPublicationPublisher;
};

/** @deprecated Use GitHubPublicationSessionRequestV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationSessionRequest = SessionGitHubPublishParams & {
  agentId: string;
  expectedRunId?: string;
  requester: GitHubPublicationRequester;
};

export type GitHubPublicationClaimRequestV2 = Omit<GitHubPublicationClaimRequest, "requester"> & {
  requester: GitHubPublicationRequesterV2;
};
export type GitHubPublicationSessionRequestV2 = Omit<
  GitHubPublicationSessionRequest,
  "requester"
> & { requester: GitHubPublicationRequesterV2 };
