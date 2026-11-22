import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { formatConfigPatchPath } from "../../../../src/config/patch-replace-paths.js";
import type { GatewayOperatorRoleDefinition } from "../../../../src/config/types.gateway.js";
import { operatorScopeSatisfied } from "../../../../src/shared/operator-scope-compat.js";
import type { ConfigPatchOptions } from "../../lib/config/config-gateway-operations.ts";

const ROLE_DEFINITIONS_PATH = "gateway.roles.definitions";

/** One `gateway.roles.definitions` entry, as far as project sharing reads it. */
export type ConfiguredRole = Pick<GatewayOperatorRoleDefinition, "agents" | "projects"> & {
  name: string;
  scopes: readonly string[];
};

/**
 * Why a role's share is fixed. `null` means the project ID in the role's
 * `projects` list decides it, so an admin can switch it. A role without a share
 * may still use public GitHub repositories through the Gateway's fallback; these
 * values describe explicit shares and full access, not that fallback.
 */
export type RoleAccessReason = "admin" | "write" | "all" | "no-sessions" | "agents" | null;

export type RoleProjectAccess = { role: string; enabled: boolean; reason: RoleAccessReason };

function readStringList(value: unknown): "*" | string[] | undefined {
  if (value === "*") {
    return "*";
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function roleDefinitions(config: Readonly<Record<string, unknown>> | null) {
  const gateway = config?.gateway;
  const roles = isRecord(gateway) ? gateway.roles : undefined;
  const definitions = isRecord(roles) ? roles.definitions : undefined;
  return isRecord(definitions) ? definitions : null;
}

/** Named roles from the Gateway configuration; `null` when named roles aren't configured. */
export function readConfiguredRoles(
  config: Readonly<Record<string, unknown>> | null,
): ConfiguredRole[] | null {
  const definitions = roleDefinitions(config);
  if (!definitions) {
    return null;
  }
  return Object.entries(definitions)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, definition]) => ({
      name,
      scopes: Array.isArray(definition.scopes)
        ? definition.scopes.filter((scope): scope is string => typeof scope === "string")
        : [],
      agents: readStringList(definition.agents) ?? [],
      projects: readStringList(definition.projects),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Explicit shares and full access per role; the Gateway still decides each request. */
export function roleProjectAccess(role: ConfiguredRole, project: ProjectRecord): RoleProjectAccess {
  const allows = (scope: string) => operatorScopeSatisfied(scope, role.scopes);
  const access = (enabled: boolean, reason: RoleAccessReason) => ({
    role: role.name,
    enabled,
    reason,
  });
  if (allows("operator.admin")) {
    return access(true, "admin");
  }
  const canStartSessions =
    allows("operator.sessions.write") && (role.agents === "*" || role.agents.length > 0);
  if (project.source === "workspace") {
    return access(
      canStartSessions &&
        (role.agents === "*" || Boolean(project.agentId && role.agents.includes(project.agentId))),
      "agents",
    );
  }
  if (allows("operator.write")) {
    return access(true, "write");
  }
  if (!canStartSessions) {
    return access(false, "no-sessions");
  }
  if (role.projects === "*") {
    return access(true, "all");
  }
  return access(role.projects?.includes(project.id) ?? false, null);
}

/**
 * Adds or removes one project ID from a role's `projects` list, built against the
 * snapshot the patch is based on. An emptied list is deleted, restoring the role's
 * default access.
 */
export function roleProjectsPatch(
  config: Readonly<Record<string, unknown>>,
  roleName: string,
  projectId: string,
  enabled: boolean,
): { options: ConfigPatchOptions } | { error: "missing" | "all" } {
  const definition = roleDefinitions(config)?.[roleName];
  if (!isRecord(definition)) {
    return { error: "missing" };
  }
  const current = readStringList(definition.projects);
  if (current === "*") {
    return { error: "all" };
  }
  const listed = current ?? [];
  const next = enabled
    ? [...new Set([...listed, projectId])]
    : listed.filter((id) => id !== projectId);
  const path = `${formatConfigPatchPath(ROLE_DEFINITIONS_PATH, roleName)}.projects`;
  return {
    options: {
      raw: {
        gateway: {
          roles: { definitions: { [roleName]: { projects: next.length ? next : null } } },
        },
      },
      note: `projects: ${enabled ? "share" : "unshare"} ${projectId} with role ${roleName}`,
      // Removing an ID shrinks the array; the Gateway requires that intent to be explicit.
      ...(next.length < listed.length ? { replacePaths: [path] } : {}),
    },
  };
}
