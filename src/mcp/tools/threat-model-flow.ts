import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import type { RadarDefenderConfig, RadarToolName } from "../../core/types.js";

export const threatModelFlowToolName: RadarToolName = "threat_model_flow";

export const threatModelFlowTool = {
  name: threatModelFlowToolName,
  description:
    "Threat-model a supplied Radar product flow without executing or probing any live system.",
  inputSchema: {
    flow_name: z.string().min(1).describe("Human-readable flow name."),
    actors: z.array(z.string()).min(1).describe("Actors involved in the flow."),
    assets: z.array(z.string()).min(1).describe("Assets or records touched by the flow."),
    steps: z.array(z.string()).min(1).describe("Ordered flow steps."),
    trust_boundaries: z
      .array(z.string())
      .optional()
      .describe("Optional trust boundary descriptions."),
    notes: z.string().optional().describe("Optional risk context or assumptions."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: {
      flow_name: string;
      actors: string[];
      assets: string[];
      steps: string[];
      trust_boundaries?: string[];
      notes?: string;
    },
    config: RadarDefenderConfig,
  ) {
    const content = [
      `Flow: ${args.flow_name}`,
      `Actors: ${args.actors.join(", ")}`,
      `Assets: ${args.assets.join(", ")}`,
      `Steps: ${args.steps.join(" -> ")}`,
      `Trust boundaries: ${(args.trust_boundaries ?? []).join(", ")}`,
      `Notes: ${args.notes ?? ""}`,
    ].join("\n");

    const execution = reviewArtifact({
      artifact: {
        kind: "flow",
        name: args.flow_name,
        content,
        metadata: {
          actors: args.actors,
          assets: args.assets,
          steps: args.steps,
          trustBoundaries: args.trust_boundaries,
          notes: args.notes,
        },
      },
      reviewConfig: config.review,
    });
    const result = buildReviewResult({
      tool: threatModelFlowToolName,
      target: args.flow_name,
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
