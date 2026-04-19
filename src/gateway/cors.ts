import type { ServerResponse } from "node:http";
import type { GatewayHttpCorsConfig } from "../config/types.gateway.js";

export type CorsCoveredEndpoint = "chatCompletions" | "responses" | "toolsInvoke" | "models";

export type CorsDecision = {
  allowOrigin: string;
  allowCredentials: boolean;
  allowMethods: string;
  allowHeaders: string;
  exposeHeaders: string | undefined;
  maxAge: number;
  isPreflight: boolean;
};

const DEFAULT_ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Request-ID"];
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const DEFAULT_MAX_AGE = 600;

/**
 * Classify a request path + method into a CORS-covered endpoint key, or null
 * if the endpoint is not covered or is disabled.
 */
export function classifyCorsEndpoint(
  method: string,
  pathname: string,
  endpointsEnabled: { chatCompletions: boolean; responses: boolean; models: boolean },
): CorsCoveredEndpoint | null {
  const m = method.toUpperCase();
  const isOptionsOrPost = m === "OPTIONS" || m === "POST";
  const isOptionsOrGet = m === "OPTIONS" || m === "GET";

  if (isOptionsOrPost && pathname === "/v1/chat/completions" && endpointsEnabled.chatCompletions) {
    return "chatCompletions";
  }
  if (isOptionsOrPost && pathname === "/v1/responses" && endpointsEnabled.responses) {
    return "responses";
  }
  if (isOptionsOrPost && pathname === "/tools/invoke") {
    return "toolsInvoke";
  }
  if (
    isOptionsOrGet &&
    endpointsEnabled.models &&
    (pathname === "/v1/models" || pathname.startsWith("/v1/models/"))
  ) {
    return "models";
  }
  return null;
}

/**
 * Resolve CORS for a single request. Returns null if CORS headers should not
 * be emitted (disabled, no origin, origin miss, non-covered endpoint).
 */
export function resolveCorsForRequest(params: {
  method: string;
  origin: string | undefined;
  accessControlRequestMethod: string | undefined;
  endpointKey: CorsCoveredEndpoint | null;
  config: GatewayHttpCorsConfig | undefined;
}): CorsDecision | null {
  const { config, endpointKey, origin, method } = params;
  if (!config?.enabled || !endpointKey || !origin) {
    return null;
  }

  const allowedOrigins = config.allowedOrigins ?? [];
  const isWildcard = allowedOrigins.includes("*");
  const originMatch = isWildcard || allowedOrigins.includes(origin);
  if (!originMatch) {
    return null;
  }

  const allowCredentials = config.allowCredentials === true && !isWildcard;
  const configHeaders = config.allowedHeaders ?? [];
  const allHeaders = [...new Set([...DEFAULT_ALLOWED_HEADERS, ...configHeaders])];
  const exposeHeaders =
    config.exposedHeaders && config.exposedHeaders.length > 0
      ? config.exposedHeaders.join(", ")
      : undefined;
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;

  const isPreflight =
    method.toUpperCase() === "OPTIONS" && params.accessControlRequestMethod !== undefined;

  return {
    allowOrigin: isWildcard && !allowCredentials ? "*" : origin,
    allowCredentials,
    allowMethods: ALLOWED_METHODS,
    allowHeaders: allHeaders.join(", "),
    exposeHeaders,
    maxAge,
    isPreflight,
  };
}

/**
 * Set CORS response headers on a ServerResponse based on a CorsDecision.
 */
export function applyCorsHeaders(res: ServerResponse, decision: CorsDecision): void {
  res.setHeader("Access-Control-Allow-Origin", decision.allowOrigin);
  res.setHeader("Vary", "Origin");
  if (decision.allowCredentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (decision.isPreflight) {
    res.setHeader("Access-Control-Allow-Methods", decision.allowMethods);
    res.setHeader("Access-Control-Allow-Headers", decision.allowHeaders);
    res.setHeader("Access-Control-Max-Age", String(decision.maxAge));
  }
  if (decision.exposeHeaders) {
    res.setHeader("Access-Control-Expose-Headers", decision.exposeHeaders);
  }
}
