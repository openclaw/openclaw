// Gateway method policy helpers classify reserved and operator-only gateway methods.
const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES = [
  "exec.approvals.",
  "config.",
  "wizard.",
  "update.",
] as const;

const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE = "operator.admin" as const;

/** Resolve the mandatory scope for reserved gateway methods. */
export function resolveReservedGatewayMethodScope(
  method: string,
): typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined {
  if (!RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return undefined;
  }
  return RESERVED_ADMIN_GATEWAY_METHOD_SCOPE;
}

/** Coerce plugin-declared scopes away from unsafe reserved gateway method scopes. */
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

/** Personal credential acquisition retains the legacy enrollment-bearing grant. */
export function resolvePersonalCredentialEnrollmentScope(
  method: string,
): "operator.read" | "operator.write" | undefined {
  switch (method) {
    case "users.authConnect.start":
    case "users.authConnect.answer":
      return "operator.write";
    case "users.github.authorize.start":
    case "users.github.authorize.poll":
      return "operator.read";
    default:
      return undefined;
  }
}
