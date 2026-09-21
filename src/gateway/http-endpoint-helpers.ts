// Gateway HTTP endpoint helpers.
// Wraps common POST JSON method, auth, scope, and body handling.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import { sendGatewayHttpAuthFailure } from "./http-operator-access.js";
import {
  authorizeGatewayHttpRequestOrReply,
  type AuthorizedGatewayHttpRequest,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";

/** Handles a gateway POST JSON endpoint and returns the parsed body when authorized. */
export async function handleGatewayPostJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    pathname: string;
    auth: ResolvedGatewayAuth;
    maxBodyBytes: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    requiredOperatorMethod?: "chat.send" | (string & Record<never, never>);
    resolveOperatorScopes?: (
      req: IncomingMessage,
      requestAuth: AuthorizedGatewayHttpRequest,
    ) => string[];
  },
): Promise<
  | false
  | { body: unknown; requestAuth: AuthorizedGatewayHttpRequest; operatorScopes: string[] }
  | undefined
> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== opts.pathname) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return undefined;
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
    return undefined;
  }

  const operatorScopes =
    opts.resolveOperatorScopes?.(req, requestAuth) ??
    resolveTrustedHttpOperatorScopes(req, requestAuth);
  if (opts.requiredOperatorMethod) {
    const scopeAuth = authorizeOperatorScopesForMethod(opts.requiredOperatorMethod, operatorScopes);
    if (!scopeAuth.allowed) {
      sendMissingScopeForbidden(res, scopeAuth.missingScope);
      return undefined;
    }
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
  if (body === undefined) {
    return undefined;
  }
  if (!hasCurrentGatewayOperatorAccess(requestAuth.operatorAccessAuthority)) {
    if (!res.writableEnded && !res.destroyed) {
      sendGatewayHttpAuthFailure(res, { ok: false, reason: "operator_access_denied" });
    }
    return undefined;
  }

  return { body, requestAuth, operatorScopes };
}
