import { isDeepStrictEqual } from "node:util";
import type {
  GatewayOperatorRoleDefinition,
  GatewayOperatorRolesConfig,
} from "../config/types.gateway.js";

/** Persist the existing role-policy shape until saved-source writers are retired. */
export function sourceRolePolicy(role: GatewayOperatorRoleDefinition | undefined) {
  if (!role) {
    return undefined;
  }
  // Keep the durable JSON shape while readers derive restrictions from current policy.
  return {
    sessions: role.sessions,
    agents: role.agents,
    scopes: role.scopes,
    ...(role.projects !== undefined ? { projects: role.projects } : {}),
    ...(role.workerProfiles !== undefined ? { workerProfiles: role.workerProfiles } : {}),
    ...(role.accessPrograms
      ? { accessPrograms: { cyber: [...new Set(role.accessPrograms.cyber)].toSorted() } }
      : {}),
    ...(role.sandbox !== undefined ? { sandbox: role.sandbox } : {}),
    ...(role.accessPolicyPlugin !== undefined
      ? { accessPolicyPlugin: role.accessPolicyPlugin }
      : {}),
  };
}

function sourceRolePolicies(roles: GatewayOperatorRolesConfig | undefined) {
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
