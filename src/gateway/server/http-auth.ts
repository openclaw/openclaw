import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { GatewayWsClient } from "./ws-types.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../../canvas-host/a2ui.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { CANVAS_CAPABILITY_TTL_MS } from "../canvas-capability.js";
import { authorizeGatewayBearerRequestOrReply } from "../http-auth-helpers.js";
import { getBearerToken } from "../http-utils.js";
import { isPrivateOrLoopbackAddress, resolveClientIp } from "../net.js";
import { GATEWAY_CLIENT_MODES, normalizeGatewayClientMode } from "../protocol/client-info.js";

export function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function isNodeWsClient(client: GatewayWsClient): boolean {
  if (client.connect.role === "node") {
    return true;
  }
  return normalizeGatewayClientMode(client.connect.client.mode) === GATEWAY_CLIENT_MODES.NODE;
}

/**
 * Returns true if any connected WS client has the given IP.
 * Used for canvas IP-based auth fallback: if a WS client from a private/CGNAT
 * address has been authenticated, HTTP requests from that same IP are trusted.
 */
function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, ip: string): boolean {
  for (const client of clients) {
    if (client.clientIp === ip) {
      return true;
    }
  }
  return false;
}

function hasAuthorizedNodeWsClientForCanvasCapability(
  clients: Set<GatewayWsClient>,
  capability: string,
): boolean {
  const nowMs = Date.now();
  for (const client of clients) {
    if (!isNodeWsClient(client)) {
      continue;
    }
    if (!client.canvasCapability || !client.canvasCapabilityExpiresAtMs) {
      continue;
    }
    if (client.canvasCapabilityExpiresAtMs <= nowMs) {
      continue;
    }
    if (safeEqualSecret(client.canvasCapability, capability)) {
      // Sliding expiration while the connected node keeps using canvas.
      client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
      return true;
    }
  }
  return false;
}

export async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
  canvasCapability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    allowRealIpFallback,
    clients,
    canvasCapability,
    malformedScopedPath,
    rateLimiter,
  } = params;
  if (malformedScopedPath) {
    return { ok: false, reason: "unauthorized" };
  }
  if (isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)) {
    return { ok: true };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeHttpGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter,
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  if (canvasCapability && hasAuthorizedNodeWsClientForCanvasCapability(clients, canvasCapability)) {
    return { ok: true };
  }

  // IP-based fallback: if the request comes from a private/CGNAT address and
  // there is an authenticated WS client from the same IP, allow the request.
  // Public IPs are never trusted via this path to prevent open-proxy scenarios.
  const clientIp = resolveClientIp({
    remoteAddr: req.socket?.remoteAddress,
    forwardedFor: req.headers["x-forwarded-for"] as string | undefined,
    realIp: req.headers["x-real-ip"] as string | undefined,
    trustedProxies,
    allowRealIpFallback,
  });
  if (
    clientIp &&
    isPrivateOrLoopbackAddress(clientIp) &&
    hasAuthorizedWsClientForIp(clients, clientIp)
  ) {
    return { ok: true };
  }

  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}

export async function enforcePluginRouteGatewayAuth(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  return await authorizeGatewayBearerRequestOrReply(params);
}
