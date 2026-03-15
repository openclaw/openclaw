import * as z from "zod/v4";
import { determineReviewRecommendation, getHighestSeverity } from "../policies/review-policy.js";
import {
  HIGHEST_SEVERITY_VALUES,
  RADAR_TOOL_NAMES,
  REVIEW_ANALYZERS,
  REVIEW_RECOMMENDATIONS,
  REVIEW_SEVERITIES,
  type RadarToolName,
  type ReviewExecution,
  type ReviewFinding,
  type ReviewOutputMode,
  type ReviewResult,
} from "./types.js";

export const reviewFindingOutputSchema = {
  finding: z.string(),
  severity: z.enum(REVIEW_SEVERITIES),
  affected_area: z.string(),
  preconditions: z.array(z.string()),
  why_it_matters: z.string(),
  evidence: z.array(z.string()),
  recommended_fix: z.array(z.string()),
  regression_test_idea: z.string(),
};

export const reviewResultOutputSchema = {
  tool: z.enum(RADAR_TOOL_NAMES),
  target: z.string(),
  summary: z.object({
    finding_count: z.number().int().nonnegative(),
    highest_severity: z.enum(HIGHEST_SEVERITY_VALUES),
    review_recommendation: z.enum(REVIEW_RECOMMENDATIONS),
    applied_analyzers: z.array(z.enum(REVIEW_ANALYZERS)),
  }),
  findings: z.array(z.object(reviewFindingOutputSchema)),
  unverified: z.array(z.string()),
};

export const summarizeFindingOutputSchema = {
  audience: z.enum(["engineer", "founder", "support", "auditor"]),
  summary: z.string(),
  source_finding: z.object(reviewFindingOutputSchema),
};

export function buildReviewResult(params: {
  tool: RadarToolName;
  target: string;
  execution: ReviewExecution;
}): ReviewResult {
  const highestSeverity = getHighestSeverity(params.execution.findings) ?? "none";
  return {
    tool: params.tool,
    target: params.target,
    summary: {
      finding_count: params.execution.findings.length,
      highest_severity: highestSeverity,
      review_recommendation: determineReviewRecommendation(params.execution.findings),
      applied_analyzers: [...params.execution.appliedAnalyzers],
    },
    findings: params.execution.findings,
    unverified: [...params.execution.unverified],
  };
}

function formatFindingLine(finding: ReviewFinding): string {
  return `- ${finding.severity.toUpperCase()}: ${finding.finding}`;
}

export function renderReviewResultText(result: ReviewResult, mode: ReviewOutputMode): string {
  if (mode === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines = [
    `Radar review for ${result.target}`,
    `Recommendation: ${result.summary.review_recommendation}`,
    `Findings: ${result.summary.finding_count}`,
    `Highest severity: ${result.summary.highest_severity}`,
  ];
  if (result.findings.length > 0) {
    lines.push("", ...result.findings.map(formatFindingLine));
  }
  if (result.unverified.length > 0) {
    lines.push("", `Unverified: ${result.unverified.join(" ")}`);
  }
  return lines.join("\n");
}

export function buildReviewToolResponse(result: ReviewResult, mode: ReviewOutputMode) {
  return {
    content: [
      {
        type: "text" as const,
        text: renderReviewResultText(result, mode),
      },
    ],
    structuredContent: result,
  };
}
