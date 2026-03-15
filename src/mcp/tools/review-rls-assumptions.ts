import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import type { RadarDefenderConfig, RadarToolName } from "../../core/types.js";

export const reviewRlsAssumptionsToolName: RadarToolName = "review_rls_assumptions";

export const reviewRlsAssumptionsTool = {
  name: reviewRlsAssumptionsToolName,
  description:
    "Compare RLS policy text against the API access assumptions described by the caller.",
  inputSchema: {
    table: z.string().min(1).describe("Table name."),
    policy_sql: z.string().min(1).describe("RLS policy SQL text."),
    api_assumption_summary: z
      .string()
      .min(1)
      .describe("Summary of what the API layer assumes the policy enforces."),
    notes: z.string().optional().describe("Optional reviewer notes."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: {
      table: string;
      policy_sql: string;
      api_assumption_summary: string;
      notes?: string;
    },
    config: RadarDefenderConfig,
  ) {
    const execution = reviewArtifact({
      artifact: {
        kind: "sql-policy",
        name: `${args.table} RLS assumptions`,
        content: `${args.policy_sql}\n\nAPI assumptions:\n${args.api_assumption_summary}`,
        metadata: {
          table: args.table,
          apiAssumptionSummary: args.api_assumption_summary,
          notes: args.notes,
        },
      },
      reviewConfig: config.review,
      focusAnalyzers: ["rls-alignment", "authorization-idor"],
    });
    const result = buildReviewResult({
      tool: reviewRlsAssumptionsToolName,
      target: args.table,
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
