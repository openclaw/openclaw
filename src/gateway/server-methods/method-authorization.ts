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
  const runtime = client.internal?.agentRuntimeIdentity;
  if (
    runtime &&
    (method === "exec.approval.request" ||
      method === "exec.approval.waitDecision" ||
      method === "plugin.approval.request" ||
      method === "plugin.approval.waitDecision")
  ) {
    // A live run can request review and await its own decision, never resolve it.
    return {
      error:
        context.validateAgentRuntimeApprovalAuthority?.(runtime) === true
          ? null
          : errorShape(
              ErrorCodes.FORBIDDEN,
              "agent runtime approval authority is no longer active",
            ),
    };
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
