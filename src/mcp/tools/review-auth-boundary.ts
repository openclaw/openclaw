import * as z from "zod/v4";
import {
  buildReviewResult,
  buildReviewToolResponse,
  reviewResultOutputSchema,
} from "../../core/output.js";
import { reviewArtifact } from "../../core/review-engine.js";
import type { RadarDefenderConfig, RadarToolName } from "../../core/types.js";

export const reviewAuthBoundaryToolName: RadarToolName = "review_auth_boundary";

export const reviewAuthBoundaryTool = {
  name: reviewAuthBoundaryToolName,
  description:
    "Review a route with extra focus on auth, OTP, ownership, and admin boundary assumptions.",
  inputSchema: {
    route_path: z.string().min(1).describe("Logical route path."),
    handler_source: z.string().min(1).describe("Route handler source code."),
    client_flow: z.string().optional().describe("Optional client flow summary invoking the route."),
    notes: z.string().optional().describe("Optional reviewer notes."),
  },
  outputSchema: reviewResultOutputSchema,
  async execute(
    args: {
      route_path: string;
      handler_source: string;
      client_flow?: string;
      notes?: string;
    },
    config: RadarDefenderConfig,
  ) {
    const execution = reviewArtifact({
      artifact: {
        kind: "route",
        name: `AUTH ${args.route_path}`,
        content: args.handler_source,
        metadata: {
          routePath: args.route_path,
          method: "UNKNOWN",
          clientFlow: args.client_flow,
          notes: args.notes,
        },
      },
      reviewConfig: config.review,
      focusAnalyzers: [
        "auth-bypass",
        "authorization-idor",
        "admin-boundary",
        "otp-abuse",
        "rate-limiting",
        "data-exposure",
        "input-validation",
      ],
    });
    const result = buildReviewResult({
      tool: reviewAuthBoundaryToolName,
      target: args.route_path,
      execution,
    });
    return buildReviewToolResponse(result, config.review.outputMode);
  },
};
