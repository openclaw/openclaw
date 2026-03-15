import * as z from "zod/v4";
import { reviewFindingOutputSchema, summarizeFindingOutputSchema } from "../../core/output.js";
import { summarizeFindingForAudience } from "../../core/summarize.js";
import type { RadarDefenderConfig, RadarToolName, ToolAudience } from "../../core/types.js";

export const summarizeFindingToolName: RadarToolName = "summarize_finding";

export const summarizeFindingTool = {
  name: summarizeFindingToolName,
  description:
    "Rewrite a structured finding for an engineer, founder, support operator, or auditor.",
  inputSchema: {
    finding: z.object(reviewFindingOutputSchema).describe("Structured finding to rewrite."),
    audience: z.enum(["engineer", "founder", "support", "auditor"]).describe("Target audience."),
  },
  outputSchema: summarizeFindingOutputSchema,
  async execute(
    args: {
      finding: z.infer<z.ZodObject<typeof reviewFindingOutputSchema>>;
      audience: ToolAudience;
    },
    _config: RadarDefenderConfig,
  ) {
    const summary = summarizeFindingForAudience(args.finding, args.audience);
    return {
      content: [
        {
          type: "text" as const,
          text: summary,
        },
      ],
      structuredContent: {
        audience: args.audience,
        summary,
        source_finding: args.finding,
      },
    };
  },
};
