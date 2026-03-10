import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthSurface,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  authSurface?: GatewayAuthSurface;
  allowLocalDirect?: boolean;
}): Promise<boolean> {
  if (
    params.allowLocalDirect &&
    isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)
  ) {
    return true;
  }

  const token = getBearerToken(params.req);
  const authorize =
    params.authSurface === "ws-control-ui"
      ? authorizeWsControlUiGatewayConnect
      : authorizeHttpGatewayConnect;
  const authResult = await authorize({
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
