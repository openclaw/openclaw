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

/** Shared admission for OpenAI-compatible endpoints; shared secrets retain operator scopes. */
export async function handleGatewayPostJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    pathname: string;
    maxBodyBytes: number;
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

  const operatorScopes = resolveSharedSecretHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("chat.send", operatorScopes);
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
