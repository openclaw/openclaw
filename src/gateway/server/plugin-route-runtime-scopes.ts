import type { IncomingMessage } from "node:http";
import {
  getHeader,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "../http-utils.js";
import { WRITE_SCOPE } from "../method-scopes.js";

export function resolvePluginRouteRuntimeOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): string[] {
  if (requestAuth.authMethod !== "trusted-proxy") {
    return [WRITE_SCOPE];
  }
  if (getHeader(req, "x-openclaw-scopes") === undefined) {
    return [WRITE_SCOPE];
  }
  return resolveTrustedHttpOperatorScopes(req, requestAuth);
}
