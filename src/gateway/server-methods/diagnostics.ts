import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getGatewayModelPricingCacheMeta } from "../model-pricing-cache-state.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
  "diagnostics.pricing": async ({ respond }) => {
    const meta = getGatewayModelPricingCacheMeta();
    respond(
      true,
      {
        cachedAt: meta.cachedAt || null,
        age: meta.cachedAt ? Date.now() - meta.cachedAt : null,
        ttlMs: meta.ttlMs,
        size: meta.size,
      },
      undefined,
    );
  },
};
