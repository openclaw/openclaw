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

/** Handles authenticated POST+JSON Gateway endpoints with optional operator-scope enforcement. */
export async function handleGatewayPostJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    /** Exact request path owned by the endpoint. */
    pathname: string;
    /** Resolved Gateway auth policy for this HTTP surface. */
    auth: ResolvedGatewayAuth;
    /** Maximum JSON request body size accepted before returning 413. */
    maxBodyBytes: number;
    /** Trusted proxy CIDRs/hosts used when deriving caller identity. */
    trustedProxies?: string[];
    /** Whether direct remote addresses may be used when proxy headers are absent. */
    allowRealIpFallback?: boolean;
    /** Optional auth failure budget shared with the wider Gateway HTTP layer. */
    rateLimiter?: AuthRateLimiter;
    /** Gateway method whose operator scopes gate this endpoint. */
    requiredOperatorMethod?: "chat.send" | (string & Record<never, never>);
    /** Optional override for deriving operator scopes from an authorized request. */
    resolveOperatorScopes?: (
      req: IncomingMessage,
      requestAuth: AuthorizedGatewayHttpRequest,
    ) => string[];
  },
): Promise<false | { body: unknown; requestAuth: AuthorizedGatewayHttpRequest } | undefined> {
  // Return false only when this helper does not own the path; undefined means
  // the helper consumed the request by writing an error response.
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

  // Scope checks run before body parsing so unauthorized callers cannot force
  // large JSON reads on endpoints they are not allowed to use.
  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
  if (body === undefined) {
    return undefined;
  }

  return { body, requestAuth };
}
