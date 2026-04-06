import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

export type GatewayAuthResultWithScopes = {
  ok: boolean;
  scopes?: string[];
  user?: string;
};

export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean>;
export async function authorizeGatewayBearerRequestOrReply(
  params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
  returnScopes: true,
): Promise<GatewayAuthResultWithScopes>;
export async function authorizeGatewayBearerRequestOrReply(
  params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
  returnScopes?: boolean,
): Promise<boolean | GatewayAuthResultWithScopes> {
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
  // If caller wants scope info, return it
  if (returnScopes) {
    return {
      ok: true,
      scopes: authResult.scopes,
      user: authResult.user,
    };
  }
  return true;
}
