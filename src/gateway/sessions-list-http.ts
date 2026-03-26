import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { listSessionsFromStore, loadCombinedSessionStoreForGateway } from "./session-utils.js";

function isSessionsListPath(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.pathname === "/api/sessions";
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function resolveIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

function resolveBoolParam(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  return raw === "true" || raw === "1";
}

function resolveStringParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export async function handleSessionsListHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  if (!isSessionsListPath(req)) {
    return false;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const cfg = loadConfig();
  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  const url = getRequestUrl(req);
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
  const result = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      limit: resolveIntParam(url, "limit"),
      activeMinutes: resolveIntParam(url, "activeMinutes"),
      agentId: resolveStringParam(url, "agentId"),
      search: resolveStringParam(url, "search"),
      includeDerivedTitles: resolveBoolParam(url, "includeDerivedTitles"),
      includeLastMessage: resolveBoolParam(url, "includeLastMessage"),
    },
  });

  sendJson(res, 200, result);
  return true;
}
