import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requesterMcpOAuthStoreKeyPrefix } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthPendingAuthorization, readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { completeOAuthCallback } from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { OAUTH_PAGE_CSP } from "../infra/oauth-page-csp.js";
import { renderOAuthPage } from "../shared/oauth-page.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const MCP_OAUTH_CALLBACK_MAX_URL_BYTES = 8 * 1024;
const CONNECTED_HTML = renderOAuthPage({
  title: "Account connected",
  heading: "You're connected.",
  message: "Return to the chat.",
});
const RETRY_HTML = renderOAuthPage({
  title: "Sign-in incomplete",
  heading: "Sign-in wasn't completed.",
  message: "Ask the bot to connect again.",
});
const EXPIRED_HTML = renderOAuthPage({
  title: "Sign-in link expired",
  heading: "This sign-in link expired or was already used.",
  message: "Ask the bot to connect again.",
});

type CallbackLog = Pick<Console, "warn">;

function respondHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", OAUTH_PAGE_CSP);
  res.end(body);
}

function readPendingState(lastAuthorizationUrl: string): string | undefined {
  try {
    return new URL(lastAuthorizationUrl).searchParams.get("state")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isPerRequesterServer(server: Record<string, unknown>): boolean {
  const oauth = isRecord(server.oauth) ? server.oauth : undefined;
  return server.enabled !== false && server.auth === "oauth" && oauth?.identity === "per-requester";
}

/** Completes one requester MCP OAuth redirect using durable state correlation. */
export async function handleMcpOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  params: { config: OpenClawConfig; log: CallbackLog },
): Promise<boolean> {
  if (req.method !== "GET") {
    return false;
  }
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
    return false;
  }
  const configuredServers = Object.entries(
    normalizeConfiguredMcpServers(params.config.mcp?.servers),
  )
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, rawServer]) => {
      if (!isPerRequesterServer(rawServer)) {
        return [];
      }
      const resolved = resolveMcpTransportConfig(serverName, rawServer, { logWarnings: false });
      return resolved?.kind === "http" && resolved.auth === "oauth"
        ? [{ serverName, resolved }]
        : [];
    });
  if (configuredServers.length === 0) {
    return false;
  }
  if (Buffer.byteLength(rawUrl, "utf8") > MCP_OAUTH_CALLBACK_MAX_URL_BYTES) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }

  const state = url.searchParams.get("state")?.trim();
  const context = captureOpenClawStateWorkerContext();
  const storeKey = state ? await readMcpOAuthPendingAuthorization(state, context) : undefined;
  const pending = storeKey ? await readMcpOAuthStore(storeKey, context) : undefined;
  if (!storeKey || !state || readPendingState(pending?.lastAuthorizationUrl ?? "") !== state) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }

  const configuredServer = configuredServers.find(({ serverName, resolved }) =>
    storeKey.startsWith(requesterMcpOAuthStoreKeyPrefix(serverName, resolved.url)),
  );
  if (!configuredServer) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }
  if (url.searchParams.has("error")) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }

  try {
    const result = await completeOAuthCallback(
      {
        storeKey,
        principal: "requester",
        serverName: configuredServer.serverName,
        serverUrl: configuredServer.resolved.url,
      },
      configuredServer.resolved,
      { code, state },
      undefined,
      context,
    );
    if (result === "expired") {
      respondHtml(res, 404, EXPIRED_HTML);
      return true;
    }
    respondHtml(res, 200, CONNECTED_HTML);
  } catch (error) {
    params.log.warn(
      `MCP OAuth callback failed for server "${configuredServer.serverName}": ${formatErrorMessage(error)}`,
    );
    respondHtml(res, 400, RETRY_HTML);
  }
  return true;
}
