/**
 * HTTP endpoints for channel operations (WhatsApp QR, etc.)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import { getBearerToken } from "./http-utils.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

export async function handleChannelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies: string[];
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    if (url.pathname.startsWith("/api/channels/")) {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.end();
      return true;
    }
    return false;
  }

  // WhatsApp QR code endpoint
  if (url.pathname === "/api/channels/whatsapp/qr") {
    // Allow local requests or check auth
    const isLocal = isLocalDirectRequest(req, opts.trustedProxies);
    if (!isLocal) {
      const token = getBearerToken(req);
      if (token) {
        const authResult = await authorizeGatewayConnect({
          auth: opts.auth,
          connectAuth: { token, password: token },
          req,
          trustedProxies: opts.trustedProxies,
        });
        if (!authResult.ok) {
          sendJson(res, 401, { ok: false, error: "Unauthorized" });
          return true;
        }
      } else if (opts.auth.requiresAuth) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return true;
      }
    }

    if (req.method === "GET" || req.method === "POST") {
      try {
        const accountId = url.searchParams.get("account") ?? undefined;
        const force = url.searchParams.get("force") === "true";
        
        const result = await startWebLoginWithQr({
          accountId,
          force,
          timeoutMs: 30000,
        });

        if (result.qrDataUrl) {
          sendJson(res, 200, {
            ok: true,
            qrDataUrl: result.qrDataUrl,
            message: result.message,
          });
        } else {
          sendJson(res, 200, {
            ok: true,
            qrDataUrl: null,
            message: result.message,
          });
        }
        return true;
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: String(err),
        });
        return true;
      }
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  // WhatsApp login status endpoint
  if (url.pathname === "/api/channels/whatsapp/status") {
    const isLocal = isLocalDirectRequest(req, opts.trustedProxies);
    if (!isLocal && opts.auth.requiresAuth) {
      const token = getBearerToken(req);
      if (!token) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return true;
      }
    }

    if (req.method === "GET") {
      try {
        const accountId = url.searchParams.get("account") ?? undefined;
        const result = await waitForWebLogin({
          accountId,
          timeoutMs: 1000, // Quick check
        });

        sendJson(res, 200, {
          ok: true,
          connected: result.connected,
          message: result.message,
        });
        return true;
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: String(err),
        });
        return true;
      }
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  return false;
}
