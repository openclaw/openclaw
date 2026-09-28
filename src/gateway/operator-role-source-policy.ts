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
  const { modelPolicy: _modelPolicy, ...sourcePolicy } = role;
  return sourcePolicy;
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
