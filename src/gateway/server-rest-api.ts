/**
 * server-rest-api.ts — Lightweight HTTP REST API for gateway queries.
 *
 * Exposes read-only JSON endpoints that return the same data as the
 * corresponding WebSocket JSON-RPC methods, without requiring a full
 * CLI cold-start or WebSocket handshake.
 *
 * Motivation: `openclaw status --json` takes 30-40s on modest hardware
 * because the CLI loads all 30+ provider plugins before making a simple
 * gateway query. These endpoints let integrations (Cortex IDE, dashboards,
 * monitoring scripts) fetch agent/session data in <50ms via a simple
 * HTTP GET with Bearer auth.
 *
 * Endpoints:
 *   GET /api/v1/sessions       — list recent sessions (same as sessions.list)
 *   GET /api/v1/agents         — list configured agents (same as agents.list)
 *   GET /api/v1/status         — combined sessions + agents snapshot
 *   GET /api/v1/sessions/:key  — single session detail (same as sessions.get)
 *
 * Auth: Bearer token in Authorization header (same token as WS auth).
 * Local requests (127.0.0.1/::1) bypass auth when gateway auth mode is "none".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  listAgentsForGateway,
} from "./session-utils.js";

export interface RestApiOptions {
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}

const API_PREFIX = "/api/v1/";

/**
 * Handle REST API requests. Returns true if the request was handled.
 */
export async function handleRestApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RestApiOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (!path.startsWith(API_PREFIX)) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  // Auth check — same logic as readiness details
  const authorized = await isAuthorized(req, opts);
  if (!authorized) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("WWW-Authenticate", 'Bearer realm="openclaw"');
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  const route = path.slice(API_PREFIX.length);

  try {
    switch (route) {
      case "sessions": {
        const activeMinutes = parseInt(url.searchParams.get("activeMinutes") ?? "10080", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const result = getSessionsList({ activeMinutes, limit });
        sendJson(res, result, method);
        return true;
      }

      case "agents": {
        const result = getAgentsList();
        sendJson(res, result, method);
        return true;
      }

      case "status": {
        const activeMinutes = parseInt(url.searchParams.get("activeMinutes") ?? "10080", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const sessions = getSessionsList({ activeMinutes, limit });
        const agents = getAgentsList();
        sendJson(res, { ts: Date.now(), sessions, agents }, method);
        return true;
      }

      default: {
        // Check for sessions/:key pattern
        if (route.startsWith("sessions/")) {
          const key = decodeURIComponent(route.slice("sessions/".length));
          if (key) {
            const result = getSessionDetail(key);
            if (!result) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: "Session not found" }));
              return true;
            }
            sendJson(res, result, method);
            return true;
          }
        }
        return false;
      }
    }
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Internal Server Error" }));
    return true;
  }
}

// ── Auth ──

async function isAuthorized(req: IncomingMessage, opts: RestApiOptions): Promise<boolean> {
  // Local requests bypass auth when auth mode is "none"
  if (isLocalDirectRequest(req, opts.trustedProxies, opts.allowRealIpFallback)) {
    if (opts.resolvedAuth.mode === "none") {
      return true;
    }
  }

  const bearerToken = getBearerToken(req);
  if (!bearerToken) {
    // Local requests with no auth configured → allow
    if (
      opts.resolvedAuth.mode === "none" &&
      isLocalDirectRequest(req, opts.trustedProxies, opts.allowRealIpFallback)
    ) {
      return true;
    }
    return false;
  }

  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.resolvedAuth,
    connectAuth: { token: bearerToken, password: bearerToken },
    req,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
  });
  return authResult.ok;
}

// ── Data accessors (same logic as WS method handlers) ──

function getSessionsList(opts: { activeMinutes: number; limit: number }) {
  const cfg = loadConfig();
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
  return listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      activeMinutes: opts.activeMinutes,
      limit: opts.limit,
    },
  });
}

function getAgentsList() {
  const cfg = loadConfig();
  return listAgentsForGateway(cfg);
}

function getSessionDetail(key: string) {
  const cfg = loadConfig();
  const { store } = loadCombinedSessionStoreForGateway(cfg);
  const entry = store[key];
  if (!entry) {
    return null;
  }
  return { key, ...entry };
}

// ── Response helpers ──

function sendJson(res: ServerResponse, data: unknown, method: string) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(method === "HEAD" ? undefined : JSON.stringify(data));
}
