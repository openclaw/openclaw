import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveSessionMethodScope,
  type SessionOperatorScope,
} from "../../shared/session-method-scopes-base.js";
import { holdsCronManagementGrant } from "../cron-creator-authority-grant.js";
import {
  ADMIN_SCOPE,
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../method-scopes.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { isOperatorScope } from "../operator-scopes.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "../role-policy.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./shared-types.js";

export function authorizeGatewayMethod(
  method: string,
  client: GatewayRequestOptions["client"],
  params: unknown,
  methodRegistry: GatewayMethodRegistry,
  context: GatewayRequestContext,
): { error: ErrorShape | null; sessionScope?: SessionOperatorScope } {
  // Pre-connect and health requests are allowed through; role/scope checks require the
  // authenticated connect metadata established by the gateway handshake.
  if (!client?.connect || method === "health") {
    return { error: null };
  }
  const roleRaw = client.connect.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    return { error: errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`) };
  }
  const scopes = client.connect.scopes ?? [];
  if (!isRoleAuthorizedForMethod(role, method)) {
    return { error: errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`) };
  }
  if (role === "node") {
    return { error: null };
  }
  if (client.invalidated) {
    return { error: errorShape(ErrorCodes.FORBIDDEN, "Gateway requester authority changed") };
  }
  if (resolveGatewayOperatorRoleActor(client)?.kind === "operator") {
    const roleError = authorizeCurrentOperatorRoleScopes(
      client,
      (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
    );
    if (roleError) {
      return { error: roleError };
    }
  }
  if (method === "device.scopes.requestUpgrade" || method === "device.scopes.waitUpgrade") {
    // Scope recovery must remain reachable from a paired operator whose grant is empty;
    // the handlers bind both calls to the connection's exact device identity.
    return { error: null };
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return { error: null };
  }
  const registeredScope = methodRegistry.getScope(method);
  const scopeAuth = isOperatorScope(registeredScope)
    ? authorizeOperatorScopesForRequiredScope(
        registeredScope,
        scopes,
        methodRegistry.getSessionAccess?.(method)?.allowOwnSessionScope
          ? "operator.sessions.write"
          : resolveSessionMethodScope(method, params),
        method,
      )
    : authorizeOperatorScopesForMethod(method, scopes, params);
  if (!scopeAuth.allowed) {
    // A configured channel owner's automation management runs without operator.admin; its
    // one-use grant, bound to this method and run, is the admitted authority instead.
    const runtimeIdentity = client.internal?.agentRuntimeIdentity;
    if (
      runtimeIdentity?.cronManagementGrant &&
      holdsCronManagementGrant(runtimeIdentity.cronManagementGrant, runtimeIdentity, method)
    ) {
      return { error: null };
    }
    const resolvedRequiredScopes = isOperatorScope(registeredScope)
      ? [registeredScope]
      : resolveLeastPrivilegeOperatorScopesForMethod(method, params);
    return {
      error: missingScopeErrorShape({
        missingScope: scopeAuth.missingScope,
        requiredScopes:
          resolvedRequiredScopes.length > 0 ? resolvedRequiredScopes : [scopeAuth.missingScope],
      }),
    };
  }
  return { error: null, sessionScope: scopeAuth.sessionScope };
}
