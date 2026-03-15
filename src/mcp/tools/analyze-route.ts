import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import type { RadarDefenderConfig, RadarToolName } from "../../core/types.js";

export const analyzeRouteToolName: RadarToolName = "analyze_route";

export const analyzeRouteTool = {
  name: analyzeRouteToolName,
  description: "Review a route handler for trust boundary, auth, IDOR, and validation risks.",
  inputSchema: {
    method: z.string().min(1).describe("HTTP method, for example GET or POST."),
    route_path: z.string().min(1).describe("Logical route path, for example /api/auth/register."),
    handler_source: z.string().min(1).describe("Route handler source code."),
    notes: z.string().optional().describe("Optional route context or reviewer notes."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: { method: string; route_path: string; handler_source: string; notes?: string },
    config: RadarDefenderConfig,
  ) {
    const execution = reviewArtifact({
      artifact: {
        kind: "route",
        name: `${args.method.toUpperCase()} ${args.route_path}`,
        content: args.handler_source,
        metadata: {
          method: args.method,
          routePath: args.route_path,
          notes: args.notes,
        },
      },
      reviewConfig: config.review,
    });
    const result = buildReviewResult({
      tool: analyzeRouteToolName,
      target: `${args.method.toUpperCase()} ${args.route_path}`,
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
