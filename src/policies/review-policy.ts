import {
  REVIEW_SEVERITY_RANK,
  type ReviewFinding,
  type ReviewRecommendation,
} from "../core/types.js";

export function getHighestSeverity(
  findings: Pick<ReviewFinding, "severity">[],
): ReviewFinding["severity"] | null {
  let highest: ReviewFinding["severity"] | null = null;
  for (const finding of findings) {
    if (!highest || REVIEW_SEVERITY_RANK[finding.severity] > REVIEW_SEVERITY_RANK[highest]) {
      highest = finding.severity;
    }
  }
  return highest;
}

export function determineReviewRecommendation(
  findings: Pick<ReviewFinding, "severity">[],
): ReviewRecommendation {
  const highestSeverity = getHighestSeverity(findings);
  if (!highestSeverity) {
    return "allow";
  }
  if (highestSeverity === "critical" || highestSeverity === "high") {
    return "manual_review";
  }
  if (highestSeverity === "medium") {
    return "warn";
  }
  return "allow";
}
