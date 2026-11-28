// Plain owner logic for the Roles settings page: reads gateway.roles from a config snapshot and
// turns one role change into a config.patch request. The Gateway validates and owns the result.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { DEFAULT_PARTICIPATION_TOOLS } from "../../../../src/shared/participation-tools.js";

export type SessionsOthers = "none" | "invited" | "view" | "suggest" | "write";
export type InvitedAccess = "read" | "suggest" | "send";
export type InvitedPermission = "read-only" | "guarded" | "workspace" | "full";

export type RoleDefinition = {
  sessions: {
    others: SessionsOthers;
    maxInvitedAccess?: InvitedAccess;
    invitedPermission?: InvitedPermission;
    invitedTools?: string[];
    invitedAlsoAllow?: string[];
  };
  sandbox?: "inherit" | "required";
  agents: "*" | string[];
  workerProfiles?: string[];
  scopes: string[];
  [key: string]: unknown;
};

export type RoleCatalog = {
  defaultRole: string | null;
  githubMappings: Readonly<Record<string, string>>;
  roles: readonly { name: string; definition: RoleDefinition }[];
};

export type RolePatch = { patch: Record<string, unknown>; replacePaths: string[] };
export type RolePatchError = { error: "changed" | "exists" | "missing" | "default" | "invalid" };

export const ADMIN_SCOPE = "operator.admin";
export const DEFAULT_PARTICIPANT_TOOLS: readonly string[] = DEFAULT_PARTICIPATION_TOOLS;
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

function rolesSection(config: Readonly<Record<string, unknown>> | null | undefined) {
  const gateway = config?.gateway;
  const roles = isRecord(gateway) ? gateway.roles : undefined;
  return isRecord(roles) ? roles : undefined;
}

export function readRoleCatalog(
  config: Readonly<Record<string, unknown>> | null | undefined,
): RoleCatalog {
  const roles = rolesSection(config);
  const definitions = isRecord(roles?.definitions) ? roles.definitions : {};
  const assignments = isRecord(roles?.assignments) ? roles.assignments : {};
  const mappings = isRecord(assignments.byGithubLogin) ? assignments.byGithubLogin : {};
  return {
    defaultRole: typeof roles?.default === "string" ? roles.default : null,
    githubMappings: Object.fromEntries(
      Object.entries(mappings).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    roles: Object.entries(definitions)
      .filter(
        (entry): entry is [string, RoleDefinition] =>
          isRecord(entry[1]) && isRecord(entry[1].sessions),
      )
      .map(([name, definition]) => ({ name, definition })),
  };
}

export function isValidRoleName(name: string): boolean {
  return ROLE_NAME.test(name);
}

export function isAdminRole(definition: RoleDefinition): boolean {
  return definition.scopes.includes(ADMIN_SCOPE);
}

/** Effective participant tools: the explicit list, or every default plus any additions. */
export function participantTools(definition: RoleDefinition): readonly string[] {
  const { invitedTools, invitedAlsoAllow } = definition.sessions;
  return invitedTools ?? [...new Set([...DEFAULT_PARTICIPANT_TOOLS, ...(invitedAlsoAllow ?? [])])];
}

/** Drops fields the Gateway would reject for the chosen session access. */
export function normalizeRoleDefinition(definition: RoleDefinition): RoleDefinition {
  const sessions = { ...definition.sessions };
  if (sessions.others !== "invited") {
    delete sessions.maxInvitedAccess;
    delete sessions.invitedPermission;
    delete sessions.invitedTools;
    delete sessions.invitedAlsoAllow;
  } else if (sessions.maxInvitedAccess !== "send") {
    delete sessions.invitedPermission;
    delete sessions.invitedTools;
    delete sessions.invitedAlsoAllow;
  }
  return { ...definition, sessions };
}

export type RoleIssue = "noAgents" | "noScopes";

/** Problems that would leave people with the role unable to connect or work. */
export function roleIssues(definition: RoleDefinition): RoleIssue[] {
  const issues: RoleIssue[] = [];
  if (Array.isArray(definition.agents) && definition.agents.length === 0) {
    issues.push("noAgents");
  }
  if (definition.scopes.length === 0) {
    issues.push("noScopes");
  }
  return issues;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stable).join(",") + "]";
  }
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .toSorted()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export function sameDefinition(
  a: RoleDefinition | undefined,
  b: RoleDefinition | undefined,
): boolean {
  return stable(a) === stable(b);
}

/** A merge patch only removes keys it names as null. */
function withRemovals(before: Record<string, unknown>, after: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    result[key] =
      isRecord(value) && isRecord(before[key]) ? withRemovals(before[key], value) : value;
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) {
      result[key] = null;
    }
  }
  return result;
}

function arrayPaths(prefix: string, value: Record<string, unknown>): string[] {
  return Object.entries(value).flatMap(([key, entry]) =>
    Array.isArray(entry)
      ? [prefix + "." + key]
      : isRecord(entry)
        ? arrayPaths(prefix + "." + key, entry)
        : [],
  );
}

function definitionPath(name: string) {
  return "gateway.roles.definitions." + name;
}

/**
 * Saves an edited role. The editor's loaded definition must still match the base config, so a
 * concurrent change is reported instead of overwritten.
 */
export function buildRoleEdit(
  base: Readonly<Record<string, unknown>>,
  name: string,
  loaded: RoleDefinition,
  next: RoleDefinition,
): RolePatch | RolePatchError {
  const current = readRoleCatalog(base).roles.find((role) => role.name === name)?.definition;
  if (!current) {
    return { error: "missing" };
  }
  if (!sameDefinition(current, loaded)) {
    return { error: "changed" };
  }
  const definition = normalizeRoleDefinition(next);
  if (roleIssues(definition).length > 0) {
    return { error: "invalid" };
  }
  return {
    patch: { gateway: { roles: { definitions: { [name]: withRemovals(current, definition) } } } },
    // Arrays that shrink, turn into "*" or disappear all count as intentional replacements.
    replacePaths: [
      ...new Set([
        ...arrayPaths(definitionPath(name), current),
        ...arrayPaths(definitionPath(name), definition),
      ]),
    ],
  };
}

export function buildRoleCreate(
  base: Readonly<Record<string, unknown>>,
  name: string,
  definition: RoleDefinition,
): RolePatch | RolePatchError {
  if (!isValidRoleName(name)) {
    return { error: "invalid" };
  }
  if (readRoleCatalog(base).roles.some((role) => role.name === name)) {
    return { error: "exists" };
  }
  const normalized = normalizeRoleDefinition(definition);
  if (roleIssues(normalized).length > 0) {
    return { error: "invalid" };
  }
  return {
    patch: { gateway: { roles: { definitions: { [name]: normalized } } } },
    replacePaths: [],
  };
}

/** Removes a role and points its GitHub mappings at the replacement in the same write. */
export function buildRoleDelete(
  base: Readonly<Record<string, unknown>>,
  name: string,
  replacement: string,
): RolePatch | RolePatchError {
  const catalog = readRoleCatalog(base);
  const current = catalog.roles.find((role) => role.name === name)?.definition;
  if (!current) {
    return { error: "missing" };
  }
  if (catalog.defaultRole === name) {
    return { error: "default" };
  }
  const remaining = catalog.roles.filter((role) => role.name !== name);
  if (remaining.length === 0 || !remaining.some((role) => role.name === replacement)) {
    return { error: "invalid" };
  }
  const mappings = Object.fromEntries(
    Object.entries(catalog.githubMappings)
      .filter(([, role]) => role === name)
      .map(([login]) => [login, replacement]),
  );
  return {
    patch: {
      gateway: {
        roles: {
          definitions: { [name]: null },
          ...(Object.keys(mappings).length ? { assignments: { byGithubLogin: mappings } } : {}),
        },
      },
    },
    replacePaths: arrayPaths(definitionPath(name), current),
  };
}

export function buildDefaultRole(
  base: Readonly<Record<string, unknown>>,
  name: string,
): RolePatch | RolePatchError {
  return readRoleCatalog(base).roles.some((role) => role.name === name)
    ? { patch: { gateway: { roles: { default: name } } }, replacePaths: [] }
    : { error: "missing" };
}

export type RolePreset = "guest" | "operator" | "admin" | "blank";

const PRESETS: Record<RolePreset, RoleDefinition> = {
  guest: {
    sessions: { others: "invited", maxInvitedAccess: "send" },
    sandbox: "required",
    agents: "*",
    scopes: ["operator.sessions.read", "operator.sessions.write"],
  },
  operator: {
    sessions: { others: "write" },
    agents: "*",
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
  },
  admin: { sessions: { others: "write" }, agents: "*", scopes: [ADMIN_SCOPE] },
  blank: { sessions: { others: "none" }, agents: "*", scopes: ["operator.sessions.read"] },
};

/**
 * The role administrators keep when roles turn on for everyone: an existing admin role
 * (preferring one named "admin"), or the first free built-in name to create one under.
 */
export function planAdminRole(
  catalog: Pick<RoleCatalog, "roles">,
): { name: string; create: boolean } | null {
  const admins = catalog.roles.filter((role) => isAdminRole(role.definition));
  const existing = admins.find((role) => role.name === "admin") ?? admins[0];
  if (existing) {
    return { name: existing.name, create: false };
  }
  const free = ["admin", "administrator"].find(
    (name) => !catalog.roles.some((role) => role.name === name),
  );
  return free ? { name: free, create: true } : null;
}

export function presetDefinition(preset: RolePreset): RoleDefinition {
  return structuredClone(PRESETS[preset]);
}

/** Profiles grouped by the role they currently resolve to. */
export function profilesByRole<T extends { effectiveRole?: string }>(profiles: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const profile of profiles) {
    if (profile.effectiveRole) {
      grouped.set(profile.effectiveRole, [...(grouped.get(profile.effectiveRole) ?? []), profile]);
    }
  }
  return grouped;
}
