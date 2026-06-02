const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES = [
  "exec.approvals.",
  "config.",
  "wizard.",
  "update.",
] as const;

const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE = "operator.admin" as const;

function isReservedAdminGatewayMethod(method: string): boolean {
  return RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** Returns the forced admin scope for core-owned gateway method namespaces. */
export function resolveReservedGatewayMethodScope(
  method: string,
): typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined {
  if (!isReservedAdminGatewayMethod(method)) {
    return undefined;
  }
  return RESERVED_ADMIN_GATEWAY_METHOD_SCOPE;
}

/** Coerces plugin-declared scopes away from reserved core namespaces when needed. */
export function normalizePluginGatewayMethodScope<TScope extends string>(
  method: string,
  scope: TScope | undefined,
): {
  scope: TScope | typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined;
  coercedToReservedAdmin: boolean;
} {
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (!reservedScope || !scope || scope === reservedScope) {
    return {
      scope,
      coercedToReservedAdmin: false,
    };
  }
  return {
    scope: reservedScope,
    coercedToReservedAdmin: true,
  };
}
