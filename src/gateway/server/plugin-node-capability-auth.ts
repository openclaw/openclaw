import type { IncomingMessage } from "node:http";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { getBearerToken, resolveHttpBrowserOriginPolicy } from "../http-auth-utils.js";
import {
  hasAuthorizedPluginNodeCapability,
  type PluginNodeCapabilitySurface,
} from "../plugin-node-capability.js";
import type { GatewayWsClient } from "./ws-types.js";

export async function authorizePluginNodeCapabilityRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
  nodeCapability: PluginNodeCapabilitySurface;
  capability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    allowRealIpFallback,
    clients,
    nodeCapability,
    capability,
    malformedScopedPath,
    rateLimiter,
  } = params;
  if (malformedScopedPath) {
    return { ok: false, reason: "unauthorized" };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    // Explicit bearer auth wins when valid, but failures are preserved so a
    // missing live node capability can return the concrete auth failure.
    const authResult = await authorizeHttpGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  if (
    capability &&
    hasAuthorizedPluginNodeCapability({
      clients,
      surface: nodeCapability,
      capability,
    })
  ) {
    // Node capability auth is a live websocket grant; it only authorizes the
    // requested capability and never broadens the caller's operator scopes.
    return { ok: true };
  }

  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}
