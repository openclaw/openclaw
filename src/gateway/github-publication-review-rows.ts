import { createHash } from "node:crypto";
import { gitHubPublicationReviewCandidateSchema } from "./github-publication-review-contract.js";
import type { GitHubPublicationReviewRow } from "./github-publication-review-store.types.js";

export function digestGitHubPublicationReview(
  row: Pick<
    GitHubPublicationReviewRow,
    | "review_id"
    | "session_id"
    | "session_key"
    | "agent_id"
    | "lifecycle_revision"
    | "requester_profile_id"
    | "requester_authority_json"
    | "candidate_json"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.review_id,
        row.session_id,
        row.session_key,
        row.agent_id,
        row.lifecycle_revision,
        row.requester_profile_id,
        row.requester_authority_json,
        row.candidate_json,
      ]),
    )
    .digest("hex");
}

export function readGitHubPublicationReviewCandidate(row: GitHubPublicationReviewRow) {
  if (
    !row.candidate_json ||
    !row.candidate_digest ||
    digestGitHubPublicationReview(row) !== row.candidate_digest
  ) {
    throw new Error("The publication review has no intact candidate; request a new review.");
  }
  return gitHubPublicationReviewCandidateSchema.parse(JSON.parse(row.candidate_json));
}
