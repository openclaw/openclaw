import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { GatewayOperatorRoleDefinitionSchema } from "../../../../src/config/zod-schema.gateway-roles.js";
import {
  buildDefaultRole,
  buildRoleCreate,
  buildRoleDelete,
  buildRoleEdit,
  normalizeRoleDefinition,
  participantTools,
  planAdminRole,
  presetDefinition,
  profilesByRole,
  readRoleCatalog,
  roleIssues,
  type RoleDefinition,
} from "./role-catalog.ts";

const collaborator: RoleDefinition = {
  sessions: { others: "invited", maxInvitedAccess: "send", invitedTools: ["read", "exec"] },
  sandbox: "required",
  agents: ["main"],
  scopes: ["operator.sessions.read", "operator.sessions.write"],
};

function config(): Record<string, unknown> {
  return {
    gateway: {
      roles: {
        default: "operator",
        assignments: { byGithubLogin: { octocat: "collaborator", hubot: "operator" } },
        definitions: {
          operator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
          collaborator: structuredClone(collaborator),
        },
      },
    },
  };
}

function apply(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return applyMergePatch(base, patch) as Record<string, unknown>;
}

describe("role catalog", () => {
  it("reads roles, the default and GitHub mappings from config", () => {
    const catalog = readRoleCatalog(config());
    expect(catalog.defaultRole).toBe("operator");
    expect(catalog.githubMappings).toEqual({ octocat: "collaborator", hubot: "operator" });
    expect(catalog.roles.map((role) => role.name)).toEqual(["operator", "collaborator"]);
    expect(readRoleCatalog({}).roles).toEqual([]);
  });

  it("drops invited fields the chosen session access does not allow", () => {
    expect(
      normalizeRoleDefinition({
        ...collaborator,
        sessions: { ...collaborator.sessions, others: "write" },
      }).sessions,
    ).toEqual({ others: "write" });
    expect(
      normalizeRoleDefinition({
        ...collaborator,
        sessions: { ...collaborator.sessions, maxInvitedAccess: "read", invitedPermission: "full" },
      }).sessions,
    ).toEqual({ others: "invited", maxInvitedAccess: "read" });
  });

  it("keeps a role with additional participant tools valid through edits", () => {
    const extended: RoleDefinition = {
      ...collaborator,
      sessions: { others: "invited", maxInvitedAccess: "send", invitedAlsoAllow: ["browser"] },
    };
    expect(participantTools(extended)).toContain("browser");
    expect(participantTools(extended)).toContain("read");
    const valid = (definition: RoleDefinition) =>
      GatewayOperatorRoleDefinitionSchema.safeParse(normalizeRoleDefinition(definition)).success;
    expect(valid(extended)).toBe(true);
    expect(valid({ ...extended, sessions: { ...extended.sessions, others: "write" } })).toBe(true);
    expect(
      valid({ ...extended, sessions: { ...extended.sessions, maxInvitedAccess: "read" } }),
    ).toBe(true);
  });

  it("flags roles that could not connect or start work", () => {
    expect(roleIssues({ ...collaborator, agents: [], scopes: [] })).toEqual([
      "noAgents",
      "noScopes",
    ]);
    expect(roleIssues(collaborator)).toEqual([]);
  });

  it("edits a role with removals as nulls and every touched array confirmed", () => {
    const next: RoleDefinition = {
      sessions: { others: "invited", maxInvitedAccess: "send" },
      agents: "*",
      scopes: ["operator.sessions.read"],
    };
    const result = buildRoleEdit(config(), "collaborator", collaborator, next);
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.replacePaths.toSorted()).toEqual([
      "gateway.roles.definitions.collaborator.agents",
      "gateway.roles.definitions.collaborator.scopes",
      "gateway.roles.definitions.collaborator.sessions.invitedTools",
    ]);
    const merged = apply(config(), result.patch);
    expect(
      readRoleCatalog(merged).roles.find((role) => role.name === "collaborator")?.definition,
    ).toEqual(next);
  });

  it("refuses to overwrite a role someone else changed", () => {
    const changed = config();
    const roles = (changed.gateway as { roles: { definitions: Record<string, RoleDefinition> } })
      .roles;
    roles.definitions.collaborator!.scopes = ["operator.read"];
    expect(buildRoleEdit(changed, "collaborator", collaborator, collaborator)).toEqual({
      error: "changed",
    });
    expect(buildRoleEdit(config(), "missing", collaborator, collaborator)).toEqual({
      error: "missing",
    });
    expect(
      buildRoleEdit(config(), "collaborator", collaborator, { ...collaborator, scopes: [] }),
    ).toEqual({
      error: "invalid",
    });
  });

  it("creates only new, well-named roles", () => {
    const created = buildRoleCreate(config(), "guest", presetDefinition("guest"));
    if ("error" in created) {
      throw new Error(created.error);
    }
    expect(
      readRoleCatalog(apply(config(), created.patch)).roles.map((role) => role.name),
    ).toContain("guest");
    expect(buildRoleCreate(config(), "operator", presetDefinition("guest"))).toEqual({
      error: "exists",
    });
    expect(buildRoleCreate(config(), "Design Reviewers", presetDefinition("guest"))).toEqual({
      error: "invalid",
    });
  });

  it("deletes a role, confirms its arrays and moves its GitHub mappings", () => {
    const result = buildRoleDelete(config(), "collaborator", "operator");
    if ("error" in result) {
      throw new Error(result.error);
    }
    expect(result.replacePaths.toSorted()).toEqual([
      "gateway.roles.definitions.collaborator.agents",
      "gateway.roles.definitions.collaborator.scopes",
      "gateway.roles.definitions.collaborator.sessions.invitedTools",
    ]);
    const catalog = readRoleCatalog(apply(config(), result.patch));
    expect(catalog.roles.map((role) => role.name)).toEqual(["operator"]);
    expect(catalog.githubMappings).toEqual({ octocat: "operator", hubot: "operator" });
    expect(buildRoleDelete(config(), "operator", "collaborator")).toEqual({ error: "default" });
    expect(buildRoleDelete(config(), "collaborator", "missing")).toEqual({ error: "invalid" });
  });

  it("sets the default role only to an existing role", () => {
    expect(buildDefaultRole(config(), "collaborator")).toEqual({
      patch: { gateway: { roles: { default: "collaborator" } } },
      replacePaths: [],
    });
    expect(buildDefaultRole(config(), "missing")).toEqual({ error: "missing" });
  });

  it("keeps an existing admin role or picks a free name for a new one", () => {
    const admin = presetDefinition("admin");
    const catalog = (definitions: Record<string, RoleDefinition>) =>
      readRoleCatalog({ gateway: { roles: { definitions } } });
    expect(planAdminRole(catalog({ ops: admin, admin }))).toEqual({ name: "admin", create: false });
    expect(planAdminRole(catalog({ ops: admin }))).toEqual({ name: "ops", create: false });
    // A role named admin without operator.admin does not count, and its name is taken.
    const blank = presetDefinition("blank");
    expect(planAdminRole(catalog({ admin: blank }))).toEqual({
      name: "administrator",
      create: true,
    });
    expect(planAdminRole(catalog({ admin: blank, administrator: blank }))).toBeNull();
  });

  it("groups people by the role they resolve to", () => {
    const grouped = profilesByRole([
      { id: "a", effectiveRole: "operator" },
      { id: "b", effectiveRole: "collaborator" },
      { id: "c", effectiveRole: "operator" },
      { id: "d" },
    ]);
    expect(grouped.get("operator")?.map((profile) => profile.id)).toEqual(["a", "c"]);
    expect(grouped.get("collaborator")?.map((profile) => profile.id)).toEqual(["b"]);
  });
});
