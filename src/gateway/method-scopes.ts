import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isAdminOnlyNodeInvokeCommand,
  isBrowserProxyNodeInvokeCommand,
} from "../infra/node-commands.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { operatorScopeSatisfied, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  resolveSessionMethodScope,
  type SessionOperatorScope,
} from "../shared/session-method-scopes-base.js";
import { resolveDynamicSessionMutationRequiredScope } from "../shared/session-method-scopes.js";
import { isAgentSessionResetCommand } from "./agent-command-policy.js";
import {
  isCoreGatewayMethodClassified,
  isCoreNodeGatewayMethod,
  isDynamicOperatorGatewayMethod,
  resolveCoreOperatorGatewayMethodScope,
} from "./methods/core-method-policy.js";
import { isForbiddenBrowserProxyMutation } from "./node-browser-proxy-policy.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "./operator-scopes.js";

export {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

/** Default scopes granted to CLI/operator clients when no narrower local policy is known. */
export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

function resolveScopedMethod(method: string): OperatorScope | undefined {
  // Node/dynamic sentinels are not operator scopes.
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryForContext()?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

/** Returns true when a method is reserved for node-role clients instead of operators. */
export function isNodeRoleMethod(method: string): boolean {
  return isCoreNodeGatewayMethod(method);
}

function resolveSessionActionRegisteredScopes(params: unknown): OperatorScope[] | undefined {
  const record = asOptionalRecord(params);
  if (!record) {
    return undefined;
  }
  const pluginId = normalizeOptionalString(record.pluginId);
  const actionId = normalizeOptionalString(record.actionId);
  if (!pluginId || !actionId) {
    return undefined;
  }
  const registration = getPluginRegistryForContext()?.sessionActions?.find(
    (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
  );
  if (!registration) {
    return undefined;
  }
  const requiredScopes = registration.action.requiredScopes;
  // Registered session actions default to write scope when they omit a custom
  // requirement; this preserves the historical mutation boundary.
  return requiredScopes && requiredScopes.length > 0 ? [...requiredScopes] : [WRITE_SCOPE];
}

function resolveSessionActionLeastPrivilegeScopes(params: unknown): OperatorScope[] {
  const registeredScopes = resolveSessionActionRegisteredScopes(params);
  if (registeredScopes) {
    return registeredScopes;
  }
  const record = asOptionalRecord(params);
  if (record) {
    const pluginId = normalizeOptionalString(record.pluginId);
    const actionId = normalizeOptionalString(record.actionId);
    if (pluginId && actionId) {
      // A standalone CLI/tool caller may be talking to a gateway whose live
      // plugin registry is not present in this local process. Avoid under-scoping
      // valid dynamic actions when we cannot determine the exact requirement
      // locally.
      return [...CLI_DEFAULT_OPERATOR_SCOPES];
    }
  }
  return [WRITE_SCOPE];
}

function resolveDynamicLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params: unknown,
): OperatorScope[] {
  // Dynamic methods derive authorization from params and live plugin registrations instead of
  // a single static method scope.
  if (method === "plugins.sessionAction") {
    return resolveSessionActionLeastPrivilegeScopes(params);
  }
  const record = asOptionalRecord(params);
  if (method === "agent") {
    return isAgentSessionResetCommand(record?.message) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "node.invoke") {
    const command = record?.command;
    // Invalid persistent-profile mutations must reach the handler's precise fail-closed
    // rejection instead of being disguised as an admin-scope failure.
    if (
      isBrowserProxyNodeInvokeCommand(command) &&
      isForbiddenBrowserProxyMutation(record?.params)
    ) {
      return [WRITE_SCOPE];
    }
    return isAdminOnlyNodeInvokeCommand(command) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "talk.config") {
    return record?.includeSecrets === true ? [READ_SCOPE, TALK_SECRETS_SCOPE] : [READ_SCOPE];
  }
  if (method === "environments.list") {
    const runtimeId = record && "runtimeId" in record ? record.runtimeId : undefined;
    // Match the handler: every nonempty runtime ID needs command eligibility access.
    return typeof runtimeId === "string" && runtimeId ? [WRITE_SCOPE] : [READ_SCOPE];
  }
  if (method === "channels.pairing.approve") {
    return record?.bootstrapCommandOwner === true ? [PAIRING_SCOPE, ADMIN_SCOPE] : [PAIRING_SCOPE];
  }
  if (method === "fs.listDir") {
    const targetsNode = record && Object.hasOwn(record, "nodeId");
    return [targetsNode ? ADMIN_SCOPE : WRITE_SCOPE];
  }
  if (
    method === "sessions.patch" ||
    method === "sessions.patchMany" ||
    method === "sessions.create" ||
    method === "sessions.dispatch" ||
    method === "sessions.move"
  ) {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.delete") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? ADMIN_SCOPE];
  }
  return [WRITE_SCOPE];
}

function findMissingOperatorScope(
  requiredScopes: readonly OperatorScope[],
  scopes: readonly string[],
): OperatorScope | undefined {
  return requiredScopes.find((scope) => !operatorScopeSatisfied(scope, scopes));
}

/** Returns the narrowest known operator scopes needed to call a gateway method. */
export function resolveLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params?: unknown,
): OperatorScope[] {
  if (isDynamicOperatorGatewayMethod(method)) {
    return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
  }
  const requiredScope = resolveScopedMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

/** Projects requested scopes through the original grant and this call's exact scope policy. */
export function projectOperatorScopesForMethod(params: {
  method: string;
  requestParams: unknown;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
  requiredScope?: OperatorScope;
  sessionScope?: SessionOperatorScope;
}): string[] {
  const requiredScopes = params.requiredScope
    ? [params.requiredScope]
    : resolveLeastPrivilegeOperatorScopesForMethod(params.method, params.requestParams);
  const sessionScope =
    params.sessionScope ?? resolveSessionMethodScope(params.method, params.requestParams);
  return params.requestedScopes.flatMap((requestedScope) => {
    if (
      roleScopesAllow({
        role: "operator",
        requestedScopes: [requestedScope],
        allowedScopes: params.allowedScopes,
      })
    ) {
      return [requestedScope];
    }
    // Only the method's required scope may use its narrow alternative. Unrelated
    // requested permissions and params-sensitive admin calls cannot borrow it.
    if (!isOperatorScope(requestedScope) || !requiredScopes.includes(requestedScope)) {
      return [];
    }
    const authorization = authorizeOperatorScopesForRequiredScope(
      requestedScope,
      params.allowedScopes,
      sessionScope,
      params.method,
    );
    return authorization.allowed && authorization.sessionScope ? [authorization.sessionScope] : [];
  });
}

/** Checks whether a presented operator scope set authorizes a gateway method call. */
export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
):
  | { allowed: true; sessionScope?: SessionOperatorScope }
  | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    if (method === "plugins.sessionAction") {
      const registeredScopes = resolveSessionActionRegisteredScopes(params);
      const record = asOptionalRecord(params);
      if (!registeredScopes && record) {
        const pluginId = normalizeOptionalString(record.pluginId);
        const actionId = normalizeOptionalString(record.actionId);
        if (!pluginId || !actionId) {
          // Malformed dynamic params cannot be matched to a plugin action. Any valid operator scope
          // may proceed so the handler can return the precise validation error.
          return scopes.some((scope) => isOperatorScope(scope))
            ? { allowed: true }
            : { allowed: false, missingScope: WRITE_SCOPE };
        }
      }
      const missingScope = findMissingOperatorScope(registeredScopes ?? [WRITE_SCOPE], scopes);
      return missingScope ? { allowed: false, missingScope } : { allowed: true };
    }
    const missingScope = findMissingOperatorScope(
      resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params),
      scopes,
    );
    return missingScope
      ? authorizeOperatorScopesForRequiredScope(
          missingScope,
          scopes,
          resolveSessionMethodScope(method, params),
          method,
        )
      : { allowed: true };
  }
  const requiredScope = resolveScopedMethod(method) ?? ADMIN_SCOPE;
  return authorizeOperatorScopesForRequiredScope(
    requiredScope,
    scopes,
    resolveSessionMethodScope(method, params),
    method,
  );
}

/** Checks a method registry's already-resolved static scope against presented operator scopes. */
export function authorizeOperatorScopesForRequiredScope(
  requiredScope: OperatorScope,
  scopes: readonly string[],
  sessionScope?: SessionOperatorScope,
  method?: string,
):
  | { allowed: true; sessionScope?: SessionOperatorScope }
  | { allowed: false; missingScope: OperatorScope } {
  if (operatorScopeSatisfied(requiredScope, scopes)) {
    return { allowed: true };
  }
  if (
    ((requiredScope === READ_SCOPE && sessionScope === "operator.sessions.read") ||
      ((requiredScope === WRITE_SCOPE ||
        (requiredScope === QUESTIONS_SCOPE && method?.startsWith("question."))) &&
        sessionScope === "operator.sessions.write")) &&
    operatorScopeSatisfied(sessionScope, scopes)
  ) {
    return { allowed: true, sessionScope };
  }
  return { allowed: false, missingScope: requiredScope };
}

/** Returns true when a method has any core, node, dynamic, reserved, or plugin scope policy. */
export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    return true;
  }
  return isCoreGatewayMethodClassified(method) || resolveScopedMethod(method) !== undefined;
}
