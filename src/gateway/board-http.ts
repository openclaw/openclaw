import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardStore } from "../boards/board-store.js";
import { boardStore } from "../boards/board-store.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendMethodNotAllowed, sendMissingScopeForbidden } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

export const BOARD_HTTP_PATH_PREFIX = "/__openclaw__/board/";
const BOARD_WIDGET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type BoardHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  store?: BoardStore;
};

function sendNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function parseBoardWidgetPath(pathname: string): { sessionKey: string; name: string } | undefined {
  const match = /^\/__openclaw__\/board\/([^/]+)\/([^/]+)\/index\.html$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    const sessionKey = decodeURIComponent(match[1]!);
    const name = decodeURIComponent(match[2]!);
    if (!sessionKey || sessionKey.includes("/") || !BOARD_WIDGET_NAME_PATTERN.test(name)) {
      return undefined;
    }
    return { sessionKey, name };
  } catch {
    return undefined;
  }
}

export async function handleBoardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BoardHttpOptions,
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith(BOARD_HTTP_PATH_PREFIX)) {
    return false;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }
  const path = parseBoardWidgetPath(pathname);
  if (!path) {
    sendNotFound(res);
    return true;
  }
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }
  const scopeAuth = authorizeOperatorScopesForMethod(
    "board.get",
    resolveSharedSecretHttpOperatorScopes(req, requestAuth),
  );
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }
  const document = (opts.store ?? boardStore).readWidgetHtml(path.sessionKey, path.name);
  if (!document || !("html" in document)) {
    sendNotFound(res);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
  res.setHeader("Cache-Control", "no-cache");
  res.end(document.html);
  return true;
}
