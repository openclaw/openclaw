import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getGatewayModelPricingCacheMeta } from "../model-pricing-cache-state.js";
import { GATEWAY_MODEL_PRICING_CACHE_TTL_MS } from "../model-pricing-cache.js";
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
        cachedAt: meta.cachedAt === 0 ? null : meta.cachedAt,
        age: meta.cachedAt === 0 ? null : Date.now() - meta.cachedAt,
        ttlMs: GATEWAY_MODEL_PRICING_CACHE_TTL_MS,
        size: meta.size,
      },
      undefined,
    );
  },
};
