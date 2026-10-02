import type { DB } from "../state/openclaw-state-db.generated.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";

export type GitHubPublicationReviewRow = DB["github_publication_review_candidates"];
export type GitHubPublicationReviewSelector =
  | { reviewId: string }
  | { publicationRequestId: string };
export type GitHubPublicationReviewRead =
  | { kind: "row"; selector: GitHubPublicationReviewSelector }
  | { kind: "session"; session: PublicationSessionIdentity }
  | { kind: "find"; sessionId: string; profileId: string; idempotencyKey: string }
  | { kind: "unreported" };
export type GitHubPublicationReviewObservation = Pick<
  GitHubPublicationReviewRow,
  "review_id" | "candidate_digest" | "stale_reason" | "publication_request_id"
>;
export type GitHubPublicationReviewChange = {
  reviewId: string;
  row: GitHubPublicationReviewObservation | undefined;
};
/** Native commit facts update live observations; they do not grant publication authority. */
export type GitHubPublicationCommit<T> = {
  kind: "github-publication";
  value: T;
  reviews: GitHubPublicationReviewChange[];
  sessions: Array<{ sessionKey: string; agentId: string }>;
};
export function reviewObservation(
  row: GitHubPublicationReviewRow,
): GitHubPublicationReviewObservation {
  return {
    review_id: row.review_id,
    candidate_digest: row.candidate_digest,
    stale_reason: row.stale_reason,
    publication_request_id: row.publication_request_id,
  };
}
