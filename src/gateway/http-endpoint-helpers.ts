import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  authorizeGatewayBearerRequest,
  resolveGatewayCompatibilityHttpOperatorScopes,
} from "./http-auth-helpers.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeOperatorScopesForMethod, type OperatorScope } from "./method-scopes.js";

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
    implicitCompatibilityOperatorScopes?: readonly OperatorScope[];
  },
): Promise<false | { body: unknown } | undefined> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== opts.pathname) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return undefined;
  }

  const authResult = await authorizeGatewayBearerRequest({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult) {
    return undefined;
  }

  if (opts.requiredOperatorMethod) {
    const requestedScopes = opts.implicitCompatibilityOperatorScopes
      ? resolveGatewayCompatibilityHttpOperatorScopes({
          req,
          authResult,
          fallbackScopes: opts.implicitCompatibilityOperatorScopes,
        })
      : resolveGatewayCompatibilityHttpOperatorScopes({
          req,
          authResult,
          fallbackScopes: [],
        });
    const scopeAuth = authorizeOperatorScopesForMethod(
      opts.requiredOperatorMethod,
      requestedScopes,
    );
    if (!scopeAuth.allowed) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: `missing scope: ${scopeAuth.missingScope}`,
        },
      });
      return undefined;
    }
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
  if (body === undefined) {
    return undefined;
  }

  return { body };
}
