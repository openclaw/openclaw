import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  type AuthorizedGatewayHttpRequest,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

/**
 * Handles the shared POST+JSON Gateway endpoint prelude.
 * Returns false for non-matching paths, undefined after writing a response, or
 * the parsed body plus auth facts when the caller should continue.
 */
export async function handleGatewayPostJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    /** Exact path this helper owns; matching is host-independent. */
    pathname: string;
    auth: ResolvedGatewayAuth;
    /** Per-route JSON body ceiling passed through to the bounded reader. */
    maxBodyBytes: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    /** Optional operator method checked before any request body bytes are read. */
    requiredOperatorMethod?: "chat.send" | (string & Record<never, never>);
    /** Route-specific scope resolver; defaults to trusted HTTP operator scopes. */
    resolveOperatorScopes?: (
      req: IncomingMessage,
      requestAuth: AuthorizedGatewayHttpRequest,
    ) => string[];
  },
): Promise<false | { body: unknown; requestAuth: AuthorizedGatewayHttpRequest } | undefined> {
  // Use a fixed URL base so path matching cannot be influenced by malformed or
  // attacker-controlled Host headers.
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

  if (opts.requiredOperatorMethod) {
    // Enforce operator scope before reading the body so unauthorized callers do
    // not spend body parsing budget or trigger payload diagnostics.
    const requestedScopes =
      opts.resolveOperatorScopes?.(req, requestAuth) ??
      resolveTrustedHttpOperatorScopes(req, requestAuth);
    const scopeAuth = authorizeOperatorScopesForMethod(
      opts.requiredOperatorMethod,
      requestedScopes,
    );
    if (!scopeAuth.allowed) {
      sendMissingScopeForbidden(res, scopeAuth.missingScope);
      return undefined;
    }
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
  if (body === undefined) {
    return undefined;
  }

  return { body, requestAuth };
}
