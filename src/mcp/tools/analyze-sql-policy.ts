import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import type { RadarDefenderConfig, RadarToolName } from "../../core/types.js";

export const analyzeSqlPolicyToolName: RadarToolName = "analyze_sql_policy";

export const analyzeSqlPolicyTool = {
  name: analyzeSqlPolicyToolName,
  description: "Review SQL or RLS policy text for permissive or misaligned access assumptions.",
  inputSchema: {
    table: z.string().min(1).describe("Table name the policy applies to."),
    policy_name: z.string().optional().describe("Optional policy name."),
    sql: z.string().min(1).describe("SQL policy text or DDL snippet."),
    assumed_access_pattern: z
      .string()
      .optional()
      .describe("Optional summary of the intended access contract."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: {
      table: string;
      policy_name?: string;
      sql: string;
      assumed_access_pattern?: string;
    },
    config: RadarDefenderConfig,
  ) {
    const execution = reviewArtifact({
      artifact: {
        kind: "sql-policy",
        name: args.policy_name ?? args.table,
        content: args.sql,
        metadata: {
          table: args.table,
          policyName: args.policy_name,
          assumedAccessPattern: args.assumed_access_pattern,
        },
      },
      reviewConfig: config.review,
      focusAnalyzers: ["rls-alignment", "authorization-idor"],
    });
    const result = buildReviewResult({
      tool: analyzeSqlPolicyToolName,
      target: args.policy_name ? `${args.table}:${args.policy_name}` : args.table,
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
