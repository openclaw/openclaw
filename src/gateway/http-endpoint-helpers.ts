// Shared admission for OpenAI-compatible POST JSON endpoints.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readJsonBodyOrError,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  authorizeGatewayHttpRequestOrReply,
  type AuthorizedGatewayHttpRequest,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

/** Returns a parsed body after authorizing an OpenAI-compatible request. */
export async function handleGatewayPostJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    pathname: string;
    maxBodyBytes: number;
    requiredOperatorMethod: string;
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
    ...opts,
    req,
    res,
  });
  if (!requestAuth) {
    return undefined;
  }

  // Compat HTTP treats shared-secret bearer auth as full operator access.
  const operatorScopes = resolveSharedSecretHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod(opts.requiredOperatorMethod, operatorScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return undefined;
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes);
  if (body === undefined) {
    return undefined;
  }
  try {
    await requestAuth.revalidate();
  } catch (error) {
    if (res.writableEnded || res.destroyed) {
      return undefined;
    }
    throw error;
  }

  return { body, requestAuth, operatorScopes };
}
