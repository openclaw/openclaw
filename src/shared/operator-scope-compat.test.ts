import { describe, expect, it } from "vitest";
import { roleScopesAllow } from "./operator-scope-compat.js";

describe("roleScopesAllow", () => {
  it("treats operator.read as satisfied by read/write/admin scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("keeps non-read operator scopes explicit", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("treats operator.admin as sufficient for mixed operator scope requests", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write", "operator.approvals"],
        allowedScopes: ["operator.admin", "operator.approvals"],
      }),
    ).toBe(true);
  });

  it("uses strict matching for non-operator roles", () => {
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["system.run"],
        allowedScopes: ["operator.admin", "system.run"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["system.run"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
  });
});
