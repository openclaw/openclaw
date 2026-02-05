/**
 * Gateway HTTP endpoints for OAuth connection flows.
 *
 * Endpoints:
 *   GET  /oauth/authorize/:provider - Initiate OAuth flow
 *   GET  /oauth/callback/:provider  - Handle provider callback
 *   POST /oauth/store/:provider     - Store credentials (from Clawdbrain backend)
 *   GET  /oauth/status/:provider    - Get connection status
 *   DELETE /oauth/:provider         - Disconnect provider
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthFlowState } from "../../providers/connections/types.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import {
  getConnectionProvider,
  getConnectionProviderIds,
  getConnectionStatus,
  storeConnectionCredential,
  removeConnectionCredential,
  getDefaultScopes,
  getScopesForPreset,
} from "../../providers/connections/index.js";
import {
  startOAuthFlow,
  completeOAuthFlow,
  getClientCredentials,
} from "../../providers/connections/oauth-flow.js";
import { authorizeGatewayConnect } from "../auth.js";
import { sendJson, sendText, sendMethodNotAllowed, sendUnauthorized } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";

const OAUTH_PATH_PREFIX = "/oauth";

// In-memory store for pending OAuth flows (keyed by state)
// In production, this should be persisted or use a more robust store
const pendingFlows = new Map<string, OAuthFlowState>();

// Clean up old flows (older than 10 minutes)
function cleanupOldFlows(): void {
  const maxAge = 10 * 60 * 1000;
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > maxAge) {
      pendingFlows.delete(state);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldFlows, 5 * 60 * 1000);

/**
 * Parse provider ID and action from OAuth path.
 * Returns null if path doesn't match OAuth pattern.
 */
function parseOAuthPath(
  pathname: string,
): {
  action: "authorize" | "callback" | "store" | "status" | "disconnect";
  providerId: string;
} | null {
  if (!pathname.startsWith(OAUTH_PATH_PREFIX)) {
    return null;
  }

  const rest = pathname.slice(OAUTH_PATH_PREFIX.length);

  // /oauth/authorize/:provider
  const authorizeMatch = rest.match(/^\/authorize\/([a-z0-9-]+)\/?$/i);
  if (authorizeMatch) {
    return { action: "authorize", providerId: authorizeMatch[1] };
  }

  // /oauth/callback/:provider
  const callbackMatch = rest.match(/^\/callback\/([a-z0-9-]+)\/?$/i);
  if (callbackMatch) {
    return { action: "callback", providerId: callbackMatch[1] };
  }

  // /oauth/store/:provider
  const storeMatch = rest.match(/^\/store\/([a-z0-9-]+)\/?$/i);
  if (storeMatch) {
    return { action: "store", providerId: storeMatch[1] };
  }

  // /oauth/status/:provider
  const statusMatch = rest.match(/^\/status\/([a-z0-9-]+)\/?$/i);
  if (statusMatch) {
    return { action: "status", providerId: statusMatch[1] };
  }

  // /oauth/:provider (for DELETE)
  const disconnectMatch = rest.match(/^\/([a-z0-9-]+)\/?$/i);
  if (disconnectMatch) {
    return { action: "disconnect", providerId: disconnectMatch[1] };
  }

  return null;
}

/**
 * Handle OAuth authorization initiation.
 * GET /oauth/authorize/:provider?scopes=...&preset=...&redirect_uri=...
 */
async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
  url: URL,
): Promise<void> {
  const provider = getConnectionProvider(providerId);
  if (!provider) {
    sendJson(res, 404, {
      error: { message: `Unknown provider: ${providerId}`, type: "not_found" },
      availableProviders: getConnectionProviderIds(),
    });
    return;
  }

  // Parse query parameters
  const scopesParam = url.searchParams.get("scopes");
  const presetParam = url.searchParams.get("preset");
  const redirectUri = url.searchParams.get("redirect_uri");

  if (!redirectUri) {
    sendJson(res, 400, {
      error: { message: "Missing redirect_uri parameter", type: "invalid_request_error" },
    });
    return;
  }

  // Get client credentials
  let clientId: string;
  try {
    const creds = getClientCredentials(providerId);
    clientId = creds.clientId;
  } catch (err) {
    sendJson(res, 500, {
      error: {
        message: err instanceof Error ? err.message : "Missing OAuth credentials",
        type: "configuration_error",
      },
    });
    return;
  }

  // Determine scopes
  let scopes: string[];
  if (scopesParam) {
    scopes = scopesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (presetParam) {
    const presetScopes = getScopesForPreset(providerId, presetParam);
    if (!presetScopes) {
      sendJson(res, 400, {
        error: { message: `Unknown preset: ${presetParam}`, type: "invalid_request_error" },
      });
      return;
    }
    scopes = presetScopes;
  } else {
    scopes = getDefaultScopes(providerId);
  }

  // Start OAuth flow
  const flowResult = startOAuthFlow({
    providerId,
    clientId,
    redirectUri,
    scopes,
  });

  if ("error" in flowResult) {
    sendJson(res, 500, {
      error: { message: flowResult.error, type: "oauth_error" },
    });
    return;
  }

  // Store the flow state for callback verification
  pendingFlows.set(flowResult.flowState.state, flowResult.flowState);

  // Redirect to provider's authorization URL
  res.statusCode = 302;
  res.setHeader("Location", flowResult.authorizeUrl);
  res.end();
}

/**
 * Handle OAuth callback from provider.
 * GET /oauth/callback/:provider?code=...&state=...
 */
async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
  url: URL,
): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Handle error response from provider
  if (error) {
    sendCallbackHtml(res, false, errorDescription ?? error);
    return;
  }

  if (!code || !state) {
    sendCallbackHtml(res, false, "Missing code or state parameter");
    return;
  }

  // Look up the pending flow
  const flowState = pendingFlows.get(state);
  if (!flowState) {
    sendCallbackHtml(res, false, "Invalid or expired OAuth state");
    return;
  }

  // Verify provider matches
  if (flowState.providerId !== providerId) {
    sendCallbackHtml(res, false, "Provider mismatch");
    return;
  }

  // Get client credentials
  let clientId: string;
  let clientSecret: string | undefined;
  try {
    const creds = getClientCredentials(providerId);
    clientId = creds.clientId;
    clientSecret = creds.clientSecret;
  } catch (err) {
    sendCallbackHtml(res, false, err instanceof Error ? err.message : "Missing OAuth credentials");
    return;
  }

  // Complete the OAuth flow
  const result = await completeOAuthFlow({
    flowState,
    code,
    receivedState: state,
    clientId,
    clientSecret,
  });

  // Clean up the pending flow
  pendingFlows.delete(state);

  if (!result.success) {
    sendCallbackHtml(res, false, result.error ?? "OAuth flow failed");
    return;
  }

  const userLabel = result.userInfo?.email ?? result.userInfo?.username ?? result.userInfo?.name;
  sendCallbackHtml(res, true, userLabel ? `Connected as ${userLabel}` : "Connection successful");
}

/**
 * Handle credential storage from Clawdbrain backend.
 * POST /oauth/store/:provider
 */
async function handleStore(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
): Promise<void> {
  const provider = getConnectionProvider(providerId);
  if (!provider) {
    sendJson(res, 404, {
      error: { message: `Unknown provider: ${providerId}`, type: "not_found" },
    });
    return;
  }

  // Read JSON body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) {
      sendJson(res, 413, {
        error: { message: "Request body too large", type: "invalid_request_error" },
      });
      return;
    }
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    sendJson(res, 400, {
      error: { message: "Invalid JSON body", type: "invalid_request_error" },
    });
    return;
  }

  const { access, refresh, expires, email, grantedScopes, userInfo } = data;

  if (typeof access !== "string" || !access.trim()) {
    sendJson(res, 400, {
      error: { message: "Missing or invalid access token", type: "invalid_request_error" },
    });
    return;
  }

  const profileId = storeConnectionCredential({
    providerId,
    access: access.trim(),
    refresh: typeof refresh === "string" ? refresh.trim() : undefined,
    expires: typeof expires === "number" ? expires : undefined,
    email: typeof email === "string" ? email : undefined,
    grantedScopes: Array.isArray(grantedScopes)
      ? grantedScopes.filter((s) => typeof s === "string")
      : undefined,
    userInfo:
      userInfo && typeof userInfo === "object" ? (userInfo as Record<string, unknown>) : undefined,
  });

  sendJson(res, 200, { ok: true, profileId });
}

/**
 * Handle connection status request.
 * GET /oauth/status/:provider
 */
async function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
): Promise<void> {
  const status = getConnectionStatus(providerId);
  if (!status) {
    sendJson(res, 404, {
      error: { message: `Unknown provider: ${providerId}`, type: "not_found" },
    });
    return;
  }

  sendJson(res, 200, status);
}

/**
 * Handle disconnect request.
 * DELETE /oauth/:provider
 */
async function handleDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
): Promise<void> {
  const provider = getConnectionProvider(providerId);
  if (!provider) {
    sendJson(res, 404, {
      error: { message: `Unknown provider: ${providerId}`, type: "not_found" },
    });
    return;
  }

  const removed = removeConnectionCredential(providerId);
  sendJson(res, 200, { ok: true, removed });
}

/**
 * Send HTML response for OAuth callback page.
 */
function sendCallbackHtml(res: ServerResponse, success: boolean, message: string): void {
  const title = success ? "Success" : "Error";
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "✓" : "✗";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Clawdbrain OAuth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f9fafb;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 400px;
    }
    .icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: ${color};
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 1rem;
    }
    h1 {
      color: #111827;
      margin: 0 0 0.5rem;
    }
    p {
      color: #6b7280;
      margin: 0;
    }
    .close-hint {
      margin-top: 1rem;
      font-size: 0.875rem;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="close-hint">You can close this window now.</p>
  </div>
</body>
</html>`;

  res.statusCode = success ? 200 : 400;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

/**
 * Create OAuth HTTP request handler.
 */
export function createOAuthHttpHandler(opts: {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  bindHost: string;
  port: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${opts.bindHost}:${opts.port}`);
    const parsed = parseOAuthPath(url.pathname);

    if (!parsed) {
      return false;
    }

    const { action, providerId } = parsed;

    // Callback endpoint doesn't require auth (user is redirected from provider)
    if (action === "callback") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      await handleCallback(req, res, providerId, url);
      return true;
    }

    // Authorize endpoint doesn't require auth (initiates flow)
    if (action === "authorize") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      await handleAuthorize(req, res, providerId, url);
      return true;
    }

    // All other endpoints require authentication
    const token = getBearerToken(req);
    const authResult = await authorizeGatewayConnect({
      auth: opts.auth,
      connectAuth: { token },
      req,
      trustedProxies: opts.trustedProxies,
    });

    if (!authResult.ok) {
      sendUnauthorized(res);
      return true;
    }

    if (action === "store") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return true;
      }
      await handleStore(req, res, providerId);
      return true;
    }

    if (action === "status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return true;
      }
      await handleStatus(req, res, providerId);
      return true;
    }

    if (action === "disconnect") {
      if (req.method !== "DELETE") {
        sendMethodNotAllowed(res, "DELETE");
        return true;
      }
      await handleDisconnect(req, res, providerId);
      return true;
    }

    return false;
  };
}
