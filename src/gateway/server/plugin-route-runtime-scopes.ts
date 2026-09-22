// Plugin route runtime scopes map authenticated HTTP callers to operator scopes exposed inside plugin handlers.
import type { IncomingMessage } from "node:http";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  applyHttpOperatorRoleScopeCeiling,
  getHeader,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "../http-auth-utils.js";
import { CLI_DEFAULT_OPERATOR_SCOPES, WRITE_SCOPE } from "../method-scopes.js";

/**
 * Runtime operator-scope resolver for plugin HTTP route requests.
 */
export type PluginRouteRuntimeScopeSurface = "write-default" | "trusted-operator";

/** Resolves the scopes a plugin route receives after gateway HTTP authentication. */
export function resolvePluginRouteRuntimeOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
  surface: PluginRouteRuntimeScopeSurface = "write-default",
): string[] {
  if (requestAuth.authMethod === "device-token") {
    const deviceScopes = applyHttpOperatorRoleScopeCeiling(
      requestAuth.deviceOperatorScopes ?? [],
      requestAuth,
    );
    return surface === "trusted-operator"
      ? deviceScopes
      : [WRITE_SCOPE].filter((scope) =>
          roleScopesAllow({
            role: "operator",
            requestedScopes: [scope],
            allowedScopes: deviceScopes,
          }),
        );
  }
  const useTrustedScopes =
    surface === "trusted-operator"
      ? requestAuth.trustDeclaredOperatorScopes
      : requestAuth.authMethod === "trusted-proxy" &&
        getHeader(req, "x-openclaw-scopes") !== undefined;
  if (useTrustedScopes) {
    return resolveTrustedHttpOperatorScopes(req, requestAuth);
  }
  // Ordinary plugin routes grant only write by default; a named role can narrow
  // that grant, never replace it with the role's scopes or the CLI defaults.
  const defaultScopes =
    surface === "trusted-operator" ? [...CLI_DEFAULT_OPERATOR_SCOPES] : [WRITE_SCOPE];
  return applyHttpOperatorRoleScopeCeiling(defaultScopes, requestAuth);
}
