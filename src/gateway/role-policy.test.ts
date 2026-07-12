/**
 * Tests role-policy helpers that normalize gateway-visible message roles.
 */
import { describe, expect, test } from "vitest";
import {
  filterAdvertisedGatewayMethodsForRole,
  isRoleAuthorizedForMethod,
  parseGatewayRole,
  roleCanSkipDeviceIdentity,
} from "./role-policy.js";

describe("gateway role policy", () => {
  test("parses supported roles", () => {
    expect(parseGatewayRole("operator")).toBe("operator");
    expect(parseGatewayRole("node")).toBe("node");
    expect(parseGatewayRole("member")).toBe("member");
    expect(parseGatewayRole("admin")).toBeNull();
    expect(parseGatewayRole(undefined)).toBeNull();
  });

  test("allows device-less bypass only for operator + shared auth", () => {
    expect(roleCanSkipDeviceIdentity("operator", true)).toBe(true);
    expect(roleCanSkipDeviceIdentity("operator", false)).toBe(false);
    expect(roleCanSkipDeviceIdentity("node", true)).toBe(false);
    expect(roleCanSkipDeviceIdentity("member", true)).toBe(false);
  });

  test("authorizes roles against node vs operator methods", () => {
    expect(isRoleAuthorizedForMethod("node", "node.event")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.pluginSurface.refresh")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.pluginTools.update")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.skills.update")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.pending.drain")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "status")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "status")).toBe(true);
    expect(isRoleAuthorizedForMethod("operator", "node.pluginSurface.refresh")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.pluginTools.update")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.skills.update")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.pending.drain")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.event")).toBe(false);
    expect(
      isRoleAuthorizedForMethod("member", "workspace.tab.get", {
        kind: "resource",
        member: true,
      }),
    ).toBe(true);
    expect(isRoleAuthorizedForMethod("member", "workspace.tab.get", { kind: "resource" })).toBe(
      false,
    );
    expect(isRoleAuthorizedForMethod("member", "workspace.tab.get")).toBe(false);
    expect(isRoleAuthorizedForMethod("member", "config.get", { kind: "resource" })).toBe(false);
  });

  test("filters the post-auth Hello method list to plugin resources for members", () => {
    const policies = new Map([
      ["workspace.tab.get", { kind: "resource" as const, member: true }],
      ["workspace.get", undefined],
      ["config.get", { kind: "resource" as const }],
    ]);

    expect(
      filterAdvertisedGatewayMethodsForRole(
        "member",
        ["workspace.tab.get", "workspace.get", "config.get"],
        (method) => policies.get(method),
      ),
    ).toEqual(["workspace.tab.get"]);
    expect(
      filterAdvertisedGatewayMethodsForRole(
        "operator",
        ["workspace.tab.get", "workspace.get", "config.get"],
        (method) => policies.get(method),
      ),
    ).toEqual(["workspace.tab.get", "workspace.get", "config.get"]);
  });
});
