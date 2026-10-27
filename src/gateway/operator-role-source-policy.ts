import { isDeepStrictEqual } from "node:util";
import type {
  GatewayOperatorRoleDefinition,
  GatewayOperatorRolesConfig,
} from "../config/types.gateway.js";
import { resolveMissingOperatorScope } from "../shared/operator-scope-compat.js";

/** Model ceilings can narrow a run without retiring its original operator source. */
export function sourceRolePolicy(role: GatewayOperatorRoleDefinition | undefined) {
  if (!role) {
    return undefined;
  }
  // Persisted sources and current policy share one exact JSON shape. Explicit
  // undefined optional fields must not turn a valid restart into a policy change.
  return {
    sessions: role.sessions,
    agents: role.agents,
    scopes: role.scopes,
    ...(role.accessPrograms
      ? { accessPrograms: { cyber: [...new Set(role.accessPrograms.cyber)].toSorted() } }
      : {}),
    ...(role.sandbox !== undefined ? { sandbox: role.sandbox } : {}),
    ...(role.accessPolicyPlugin !== undefined
      ? { accessPolicyPlugin: role.accessPolicyPlugin }
      : {}),
  };
}

/** Scope edits retire a source only when it loses an admitted grant. */
export function isOperatorRoleSourcePolicyCurrent(
  captured: ReturnType<typeof sourceRolePolicy>,
  current: ReturnType<typeof sourceRolePolicy>,
  scopes: readonly string[],
): boolean {
  if (!captured || !current) {
    return captured === current;
  }
  // Role grants are schema-validated enum values; only requested scopes need trimming.
  if (resolveMissingOperatorScope(scopes, current.scopes) !== null) {
    return false;
  }
  return isDeepStrictEqual({ ...captured, scopes: current.scopes }, current);
}

export function sourceRolePolicies(roles: GatewayOperatorRolesConfig | undefined) {
  return roles
    ? {
        ...roles,
        definitions: Object.fromEntries(
          Object.entries(roles.definitions).map(([name, role]) => [name, sourceRolePolicy(role)]),
        ),
      }
    : undefined;
}

/** Compare role keys as record keys; administrator-chosen names may contain dots. */
export function haveSameOperatorRoleSourcePolicies(
  previous: GatewayOperatorRolesConfig | undefined,
  next: GatewayOperatorRolesConfig | undefined,
): boolean {
  if (!previous || !next) {
    return false;
  }
  return isDeepStrictEqual(sourceRolePolicies(previous), sourceRolePolicies(next));
}
