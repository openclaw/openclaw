import { describe, expect, it } from "vitest";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { readConfiguredRoles, roleProjectAccess, roleProjectsPatch } from "./project-access.ts";

const config = {
  gateway: {
    roles: {
      definitions: {
        viewer: { agents: "*", scopes: ["operator.read"] },
        operator: { agents: "*", scopes: ["operator.read", "operator.write"] },
        contractor: { agents: ["main"], scopes: ["operator.sessions.write"], projects: ["site"] },
        partner: { agents: "*", scopes: ["operator.sessions.write"], projects: "*" },
        guest: { agents: "*", scopes: ["operator.sessions.write"] },
        admin: { agents: "*", scopes: ["operator.admin"] },
      },
    },
  },
};
const site: ProjectRecord = { id: "site", displayName: "site", source: "registered" };
const docs: ProjectRecord = { id: "docs", displayName: "docs", source: "cloned" };
const workspace: ProjectRecord = {
  id: "workspace:main",
  displayName: "main",
  source: "workspace",
  agentId: "main",
};

function accessByRole(project: ProjectRecord) {
  return Object.fromEntries(
    readConfiguredRoles(config)!.map((role) => {
      const access = roleProjectAccess(role, project);
      return [role.name, [access.enabled, access.reason]];
    }),
  );
}

describe("project role access", () => {
  it("reports no named roles when role definitions are absent", () => {
    expect(readConfiguredRoles({ gateway: {} })).toBeNull();
  });

  it("locks admin, write, wildcard and session-less roles and leaves listed grants switchable", () => {
    expect(accessByRole(site)).toEqual({
      admin: [true, "admin"],
      contractor: [true, null],
      guest: [false, null],
      operator: [true, "write"],
      partner: [true, "all"],
      viewer: [false, "no-sessions"],
    });
    expect(accessByRole(docs).contractor).toEqual([false, null]);
  });

  it("derives agent workspace access from each role's agent list", () => {
    expect(accessByRole(workspace)).toEqual({
      admin: [true, "admin"],
      contractor: [true, "agents"],
      guest: [true, "agents"],
      operator: [true, "agents"],
      partner: [true, "agents"],
      viewer: [false, "agents"],
    });
    expect(accessByRole({ ...workspace, id: "workspace:ops", agentId: "ops" }).contractor).toEqual([
      false,
      "agents",
    ]);
  });

  it("refuses to edit a wildcard or vanished role", () => {
    expect(roleProjectsPatch(config, "partner", "site", false)).toEqual({ error: "all" });
    expect(roleProjectsPatch(config, "former", "site", true)).toEqual({ error: "missing" });
  });
});
