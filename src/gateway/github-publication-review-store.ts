import { randomUUID } from "node:crypto";
import {
  encodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import { runGitHubPublicationMutation } from "./github-publication-mutation.js";
import {
  gitHubPublicationReviewCandidateSchema,
  assertDurableGitHubPublicationReview,
  type GitHubPublicationReviewCandidate,
} from "./github-publication-review-contract.js";
import { prepareGitHubPublicationReviewRead } from "./github-publication-review-publication.js";
import { digestGitHubPublicationReview } from "./github-publication-review-rows.js";
import type {
  GitHubPublicationReviewRead,
  GitHubPublicationReviewRow,
  GitHubPublicationReviewSelector,
} from "./github-publication-review-store.types.js";
export { readGitHubPublicationReviewCandidate } from "./github-publication-review-rows.js";
export type { GitHubPublicationReviewRow } from "./github-publication-review-store.types.js";

async function read(
  input: GitHubPublicationReviewRead,
  context = captureOpenClawStateWorkerContext(),
) {
  // Match shared receipt reads: retain the original owner without a whole-database
  // backup that can collide with another snapshot's retained launch context.
  const result = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "publicationReview.read", input },
      { context, current: true, preferIndependentWarmRead: true },
    ),
  );
  context.admission.assertCurrent();
  if (!result) {
    return [];
  }
  if (!result.ok || result.type !== "publicationReview.read") {
    throw new Error("Publication reviews are unavailable.");
  }
  return result.rows;
}
export async function readGitHubPublicationReview(
  selector: GitHubPublicationReviewSelector,
  context?: OpenClawStateWorkerContext,
) {
  return (await read({ kind: "row", selector }, context))[0];
}
export function prepareGitHubPublicationReviewObservation(reviewId: string) {
  const context = captureOpenClawStateWorkerContext();
  return prepareGitHubPublicationReviewRead(context.admission, reviewId, () =>
    readGitHubPublicationReview({ reviewId }, context),
  );
}
export function listGitHubPublicationReviews(session: PublicationSessionIdentity) {
  return read({ kind: "session", session });
}
export async function findGitHubPublicationReview(input: {
  sessionId: string;
  profileId: string;
  idempotencyKey: string;
}) {
  return (await read({ kind: "find", ...input }))[0];
}
export function listUnreportedGitHubPublicationReviews() {
  return read({ kind: "unreported" });
}
export function markGitHubPublicationReviewReported(reviewId: string) {
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) =>
      scope.execute({ type: "publicationReview.reported", input: { reviewId, now: Date.now() } }),
    () => {},
  );
}
export function retireGitHubPublicationReviewReport(
  input: PublicationSessionIdentity & { reviewId: string },
) {
  const captured = { ...input, now: Date.now() };
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "publicationReview.retire", input: captured }),
    () => {},
  );
}
export function markGitHubPublicationReviewStale(row: GitHubPublicationReviewRow, reason: string) {
  const input = { reviewId: row.review_id, digest: row.candidate_digest, reason };
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "publicationReview.stale", input }),
    () => {},
  );
}
/** A guest's inert request and a maintainer's candidate always receive separate identities. */
export function insertGitHubPublicationReview(input: {
  session: PublicationSessionIdentity;
  idempotencyKey: string;
  profileId: string;
  requestedReviewId?: string;
  reviewed?: {
    candidate: GitHubPublicationReviewCandidate;
    requester: GitHubPublicationRequesterSnapshot;
  };
  assertCurrent: () => void;
}): Promise<GitHubPublicationReviewRow> {
  assertDurableGitHubPublicationReview(input.session.sessionKey);
  input.assertCurrent();
  const candidateJson = input.reviewed
    ? JSON.stringify(gitHubPublicationReviewCandidateSchema.parse(input.reviewed.candidate))
    : null;
  const row: GitHubPublicationReviewRow = {
    review_id: randomUUID(),
    requested_review_id: input.requestedReviewId ?? null,
    idempotency_key: input.idempotencyKey,
    session_id: input.session.sessionId,
    session_key: input.session.sessionKey,
    agent_id: input.session.agentId,
    lifecycle_revision: input.session.lifecycleRevision ?? null,
    requester_profile_id: input.profileId,
    requester_authority_json: input.reviewed
      ? encodeGitHubPublicationRequester(input.reviewed.requester)
      : null,
    candidate_json: candidateJson,
    candidate_digest: null,
    publication_request_id: null,
    stale_reason: null,
    created_at_ms: Date.now(),
    reported_at_ms: null,
  };
  if (candidateJson) {
    row.candidate_digest = digestGitHubPublicationReview(row);
  }
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "publicationReview.insert", input: row }),
    input.assertCurrent,
  );
}
