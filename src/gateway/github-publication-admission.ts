import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PersonalGitHubPublicationRow } from "./github-personal-publication-store.js";
import { runGitHubPublicationMutation } from "./github-publication-mutation.js";
import type { PreparedGitHubPublicationReview } from "./github-publication-review-contract.js";
import type { insertGitHubPublicationRequestInDatabase as insertShared } from "./github-publication-store.js";

export type GitHubPublicationReviewBinding = { reviewId: string; digest: string };
export type SharedGitHubPublicationAdmission = Parameters<typeof insertShared>[1];
const reference = (review: PreparedGitHubPublicationReview | undefined) =>
  review ? { reviewId: review.id, digest: review.digest } : undefined;

export function insertGitHubPublicationRequest(
  input: SharedGitHubPublicationAdmission,
  assertCurrent: () => void,
  review?: PreparedGitHubPublicationReview,
) {
  // Prepared sources can carry credentials and authority closures; transport only receipt facts.
  const captured = structuredClone({
    requestId: input.requestId,
    requestDigest: input.requestDigest,
    sessionId: input.sessionId,
    lifecycleRevision: input.lifecycleRevision,
    requester: input.requester,
    now: input.now,
    claim: input.claim,
    snapshot: input.snapshot,
    request: {
      sessionKey: input.request.sessionKey,
      agentId: input.request.agentId,
      idempotencyKey: input.request.idempotencyKey,
      title: input.request.title,
      body: input.request.body,
    },
    identity: {
      source: input.identity.source,
      profileId: input.identity.profileId,
      account: input.identity.account,
    },
    worktree: {
      id: input.worktree.id,
      repoFingerprint: input.worktree.repoFingerprint,
      branch: input.worktree.branch,
    },
  });
  const binding = reference(review);
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) =>
      scope.execute({
        type: "publicationAdmission.shared",
        input: { request: captured, review: binding },
      }),
    () => {
      assertCurrent();
      review?.assertCurrent();
    },
  );
}
export function insertPersonalGitHubPublication(
  row: PersonalGitHubPublicationRow,
  lifecycleRevision: string | null,
  assertCurrent: () => void,
  review?: PreparedGitHubPublicationReview,
) {
  const input = structuredClone({ row, lifecycleRevision, review: reference(review) });
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "publicationAdmission.personal", input }),
    () => {
      assertCurrent();
      review?.assertCurrent();
    },
  );
}
export function insertRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
  review?: PreparedGitHubPublicationReview,
) {
  const input = structuredClone({ row, review: reference(review) });
  return runGitHubPublicationMutation(
    captureOpenClawStateWorkerContext(),
    (scope) => scope.execute({ type: "publicationAdmission.repository", input }),
    () => {
      assertCurrent();
      review?.assertCurrent();
    },
  );
}
