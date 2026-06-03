import { normalizeOptionalString as normalizeSessionActionParam } from "@openclaw/normalization-core/string-coerce";
import type {
  PluginRegistry,
  PluginSessionActionRegistryRegistration,
} from "../plugins/registry-types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import {
  isCoreGatewayMethodClassified,
  isCoreNodeGatewayMethod,
  isDynamicOperatorGatewayMethod,
  resolveCoreOperatorGatewayMethodScope,
} from "./methods/core-descriptors.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
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
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

/** Default scopes granted to CLI/operator clients when no narrower local policy is known. */
export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

type ReadResult<T> = { ok: true; value: T } | { ok: false };

function readField<T>(read: () => T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

function readArrayLength(value: readonly unknown[]): number | null {
  const length = readField(() => value.length);
  return length.ok && Number.isInteger(length.value) && length.value >= 0 ? length.value : null;
}

function listSessionActionRegistrations(
  registry: PluginRegistry | null | undefined,
): readonly unknown[] {
  const entries = readField(() => registry?.sessionActions);
  return entries.ok && Array.isArray(entries.value) ? entries.value : [];
}

function findSessionActionRegistration(params: {
  actionId: string;
  pluginId: string;
  registry: PluginRegistry | null | undefined;
}): PluginSessionActionRegistryRegistration | undefined {
  const entries = listSessionActionRegistrations(params.registry);
  const length = readArrayLength(entries);
  if (length === null) {
    return undefined;
  }
  let index = 0;
  while (index < length) {
    const registration = readField(() => entries[index] as PluginSessionActionRegistryRegistration);
    const pluginId: ReadResult<string> = registration.ok
      ? readField(() => registration.value.pluginId)
      : { ok: false };
    const action: ReadResult<PluginSessionActionRegistryRegistration["action"]> = registration.ok
      ? readField(() => registration.value.action)
      : { ok: false };
    const actionId: ReadResult<string> = action.ok
      ? readField(() => action.value.id)
      : { ok: false };
    if (
      pluginId.ok &&
      pluginId.value === params.pluginId &&
      actionId.ok &&
      actionId.value === params.actionId
    ) {
      return registration.value;
    }
    index += 1;
  }
  return undefined;
}

function resolveSessionActionRequiredScopes(
  registration: PluginSessionActionRegistryRegistration,
): OperatorScope[] {
  const action = readField(() => registration.action);
  const requiredScopes: ReadResult<unknown> = action.ok
    ? readField(() => action.value.requiredScopes)
    : { ok: false };
  if (!requiredScopes.ok || requiredScopes.value === undefined) {
    return [WRITE_SCOPE];
  }
  if (!Array.isArray(requiredScopes.value) || requiredScopes.value.length === 0) {
    return [WRITE_SCOPE];
  }
  const scopes = requiredScopes.value.filter((scope): scope is OperatorScope =>
    isOperatorScope(scope),
  );
  return scopes.length > 0 ? scopes : [WRITE_SCOPE];
}

function resolveScopedMethod(method: string): OperatorScope | undefined {
  // Core descriptors are authoritative, then reserved namespace policy, then active plugin
  // descriptors. Node/dynamic sentinels are intentionally excluded from operator scopes.
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryState()?.activeRegistry?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}

/** Returns true when a method requires the approvals operator scope. */
export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

/** Returns true when a method requires the pairing operator scope. */
export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

/** Returns true when a method can be satisfied by read or stronger write/admin scopes. */
export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

/** Returns true when a method requires write or admin operator scope. */
export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

/** Returns true when a method is reserved for node-role clients instead of operators. */
export function isNodeRoleMethod(method: string): boolean {
  return isCoreNodeGatewayMethod(method);
}

/** Returns true when a method requires admin operator scope. */
export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

/** Resolves the required static operator scope for a gateway method, if one exists. */
export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

function resolveSessionActionRegisteredScopes(params: unknown): OperatorScope[] | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
  const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
  if (!pluginId || !actionId) {
    return undefined;
  }
  const registration = findSessionActionRegistration({
    actionId,
    pluginId,
    registry: getPluginRegistryState()?.activeRegistry,
  });
  if (!registration) {
    return undefined;
  }
  return resolveSessionActionRequiredScopes(registration);
}

function resolveSessionActionLeastPrivilegeScopes(params: unknown): OperatorScope[] {
  const registeredScopes = resolveSessionActionRegisteredScopes(params);
  if (registeredScopes) {
    return registeredScopes;
  }
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
    const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
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
  return [WRITE_SCOPE];
}

/** Returns the narrowest known operator scopes needed to call a gateway method. */
export function resolveLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params?: unknown,
): OperatorScope[] {
  if (isDynamicOperatorGatewayMethod(method)) {
    return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

/** Checks whether a presented operator scope set authorizes a gateway method call. */
export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    const registeredScopes = resolveSessionActionRegisteredScopes(params);
    if (!registeredScopes && params && typeof params === "object" && !Array.isArray(params)) {
      const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
      const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
      if (!pluginId || !actionId) {
        // Malformed dynamic params cannot be matched to a plugin action. Any valid operator scope
        // may proceed so the handler can return the precise validation error.
        return scopes.some((scope) => isOperatorScope(scope))
          ? { allowed: true }
          : { allowed: false, missingScope: WRITE_SCOPE };
      }
    }
    const requiredScopes = registeredScopes ?? [WRITE_SCOPE];
    const missingScope = requiredScopes.find((scope) => {
      return !scopes.includes(scope) && !(scope === READ_SCOPE && scopes.includes(WRITE_SCOPE));
    });
    return missingScope ? { allowed: false, missingScope } : { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
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
  return (
    isCoreGatewayMethodClassified(method) ||
    resolveRequiredOperatorScopeForMethod(method) !== undefined
  );
}
