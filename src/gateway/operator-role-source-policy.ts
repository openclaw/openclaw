import { isDeepStrictEqual } from "node:util";
import type {
  GatewayOperatorRoleDefinition,
  GatewayOperatorRolesConfig,
} from "../config/types.gateway.js";

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
    ...(role.sandbox !== undefined ? { sandbox: role.sandbox } : {}),
    ...(role.accessPolicyPlugin !== undefined
      ? { accessPolicyPlugin: role.accessPolicyPlugin }
      : {}),
  };
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
