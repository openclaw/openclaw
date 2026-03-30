import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";

const OPERATOR_SCOPES_HEADER = "x-openclaw-scopes";

export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
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
    return false;
  }
  return true;
}

export function resolveGatewayRequestedOperatorScopes(
  req: IncomingMessage,
  auth?: ResolvedGatewayAuth,
): string[] {
  const raw = getHeader(req, OPERATOR_SCOPES_HEADER)?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }
  // No explicit scopes header. If bearer token auth was configured and
  // succeeded (auth mode is token/password, not none), treat the request
  // as a fully privileged operator.
  if (auth?.mode === "token" || auth?.mode === "password") {
    return [
      "operator.admin",
      "operator.write",
      "operator.read",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ];
  }
  return [];
}
