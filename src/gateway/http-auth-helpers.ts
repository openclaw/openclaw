import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import type { OperatorScope } from "./method-scopes.js";

const OPERATOR_SCOPES_HEADER = "x-openclaw-scopes";

type RequestedOperatorScopes = {
  present: boolean;
  scopes: string[];
};

function parseRequestedOperatorScopes(req: IncomingMessage): RequestedOperatorScopes {
  const raw = getHeader(req, OPERATOR_SCOPES_HEADER);
  if (raw === undefined) {
    return { present: false, scopes: [] };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { present: true, scopes: [] };
  }
  return {
    present: true,
    scopes: trimmed
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  };
}

function canImplicitlyTrustCompatibilityScopes(authResult: GatewayAuthResult): boolean {
  return authResult.ok && (authResult.method === "token" || authResult.method === "password");
}

export async function authorizeGatewayBearerRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult | null> {
  const token = getBearerToken(params.req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(params.res, authResult);
    return null;
  }
  return authResult;
}

export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  return (await authorizeGatewayBearerRequest(params)) !== null;
}

export function resolveGatewayRequestedOperatorScopes(req: IncomingMessage): string[] {
  return parseRequestedOperatorScopes(req).scopes;
}

export function resolveGatewayCompatibilityHttpOperatorScopes(params: {
  req: IncomingMessage;
  authResult: GatewayAuthResult;
  fallbackScopes?: readonly OperatorScope[];
}): string[] {
  const requested = parseRequestedOperatorScopes(params.req);
  if (requested.present) {
    return requested.scopes;
  }
  if (canImplicitlyTrustCompatibilityScopes(params.authResult)) {
    return [...(params.fallbackScopes ?? [])];
  }
  return [];
}
