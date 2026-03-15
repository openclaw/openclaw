import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import {
  REVIEW_SEVERITIES,
  type RadarDefenderConfig,
  type RadarToolName,
} from "../../core/types.js";

export const analyzeCodeSnippetToolName: RadarToolName = "analyze_code_snippet";

export const analyzeCodeSnippetTool = {
  name: analyzeCodeSnippetToolName,
  description: "Review a supplied code snippet for Radar-specific defensive security issues.",
  inputSchema: {
    snippet: z.string().min(1).describe("Code snippet to review."),
    language: z.string().optional().describe("Optional language hint, for example ts or sql."),
    logical_path: z.string().optional().describe("Optional logical path for reporting context."),
    notes: z.string().optional().describe("Optional reviewer notes or risk context."),
    minimum_severity: z
      .enum(REVIEW_SEVERITIES)
      .optional()
      .describe("Optional severity floor for this review call."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: {
      snippet: string;
      language?: string;
      logical_path?: string;
      notes?: string;
      minimum_severity?: (typeof REVIEW_SEVERITIES)[number];
    },
    config: RadarDefenderConfig,
  ) {
    const execution = reviewArtifact({
      artifact: {
        kind: "code-snippet",
        name: args.logical_path ?? "snippet",
        content: args.snippet,
        metadata: {
          language: args.language,
          logicalPath: args.logical_path,
          notes: args.notes,
        },
      },
      reviewConfig: {
        ...config.review,
        minimumSeverity: args.minimum_severity ?? config.review.minimumSeverity,
      },
    });

    const result = buildReviewResult({
      tool: analyzeCodeSnippetToolName,
      target: args.logical_path ?? "code snippet",
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
