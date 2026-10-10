import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MAX_TOOL_APPROVAL_REVIEWS,
  normalizeToolApprovalReview,
  type ToolApprovalReview,
} from "../../../../src/shared/tool-approval-reviews.js";

type ToolApprovalReviewOutcome = "approved" | "denied" | "reviewing";

export function readToolApprovalReviews(details: unknown): ToolApprovalReview[] {
  const values = asNullableRecord(details)?.approvalReviews;
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .slice(-MAX_TOOL_APPROVAL_REVIEWS)
    .map(normalizeToolApprovalReview)
    .filter((review): review is ToolApprovalReview => review !== null);
}

export function withToolApprovalReviews(
  details: unknown,
  reviews: readonly ToolApprovalReview[],
  outcome?: ToolApprovalReviewOutcome,
): Record<string, unknown> {
  const record = asNullableRecord(details);
  return {
    ...(record ?? (details === undefined ? {} : { toolDetails: details })),
    approvalReviews: [...reviews],
    ...(outcome ? { approvalReviewOutcome: outcome } : {}),
  };
}

export function readToolApprovalReviewOutcome(
  details: unknown,
): ToolApprovalReviewOutcome | undefined {
  const outcome = asNullableRecord(details)?.approvalReviewOutcome;
  return outcome === "approved" || outcome === "denied" || outcome === "reviewing"
    ? outcome
    : undefined;
}

export function resolveToolApprovalReviewOutcome(
  reviews: readonly ToolApprovalReview[],
  recordedOutcomes: readonly ToolApprovalReviewOutcome[] = [],
): ToolApprovalReviewOutcome | null {
  if (
    recordedOutcomes.includes("denied") ||
    reviews.some((review) => ["denied", "timed_out", "aborted"].includes(review.status))
  ) {
    return "denied";
  }
  if (
    recordedOutcomes.includes("reviewing") ||
    reviews.some((review) => review.status === "in_progress")
  ) {
    return "reviewing";
  }
  return recordedOutcomes.includes("approved") ||
    reviews.some((review) => review.status === "approved")
    ? "approved"
    : null;
}
