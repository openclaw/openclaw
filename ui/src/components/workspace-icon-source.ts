import { buildControlUiResourcePath } from "../../../src/gateway/control-ui-resource-routes.js";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { resolveControlUiAuthCandidates } from "../app/control-ui-auth.ts";

/** Authenticated route inputs for `openclaw-workspace-icon`. */
export type WorkspaceIconSource = {
  routeUrl: string;
  authTokens: readonly string[];
  authReady: boolean;
  connectionId?: string;
};

/**
 * Builds the Gateway icon route for a session's workspace or a registered
 * project. Both routes share the Gateway's workspace icon scanner and cache.
 */
export function resolveWorkspaceIconSource(params: {
  route: "workspaceIcon" | "projectIcon";
  /** Session key for `workspaceIcon`, project id for `projectIcon`. */
  value: string | undefined;
  resourceBasePath: string;
  hello: GatewayHelloOk | null;
  token: string;
  password: string;
}): WorkspaceIconSource | null {
  if (!params.value) {
    return null;
  }
  const authTokens = resolveControlUiAuthCandidates({
    hello: params.hello,
    settings: { token: params.token },
    password: params.password,
  });
  return {
    routeUrl: buildControlUiResourcePath(params.route, params.resourceBasePath, params.value),
    authTokens,
    authReady: Boolean(params.hello || authTokens.length),
    connectionId: params.hello?.server?.connId,
  };
}
