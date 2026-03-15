import { REVIEW_RULES } from "./rules.js";
import { REVIEW_SEVERITY_RANK, type ReviewArtifact, type ReviewExecution } from "./types.js";
import type { RadarDefenderReviewConfig, ReviewAnalyzerName } from "./types.js";

export type ReviewArtifactParams = {
  artifact: ReviewArtifact;
  reviewConfig: RadarDefenderReviewConfig;
  focusAnalyzers?: ReviewAnalyzerName[];
};

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function reviewArtifact(params: ReviewArtifactParams): ReviewExecution {
  const focusSet = params.focusAnalyzers ? new Set(params.focusAnalyzers) : null;
  const activeAnalyzers = params.reviewConfig.enabledAnalyzers.filter((analyzer) =>
    focusSet ? focusSet.has(analyzer) : true,
  );
  const minRank = REVIEW_SEVERITY_RANK[params.reviewConfig.minimumSeverity];
  const findings = REVIEW_RULES.flatMap((rule) => {
    if (!activeAnalyzers.includes(rule.analyzer)) {
      return [];
    }
    if (!rule.appliesTo.includes(params.artifact.kind)) {
      return [];
    }
    return rule.evaluate(params.artifact);
  }).filter((finding) => REVIEW_SEVERITY_RANK[finding.severity] >= minRank);

  const unverified = [
    "Static artifact review only; no filesystem reads, runtime execution, or network calls were performed.",
  ];
  if (params.artifact.kind === "flow") {
    unverified.push(
      "Threat model findings reflect only the supplied flow description, not the live implementation.",
    );
  }

  return {
    findings,
    appliedAnalyzers: dedupe(activeAnalyzers),
    unverified,
  };
}
