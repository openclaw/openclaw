import { describe, expect, it } from "vitest";
import { roleScopesAllow } from "./operator-scope-compat.js";

describe("roleScopesAllow", () => {
  it("allows empty requested scope lists regardless of granted scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: [],
        allowedScopes: [],
      }),
    ).toBe(true);
  });

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

  it("treats operator.write as satisfied by write/admin scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("treats operator.approvals/operator.pairing as satisfied by operator.admin", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.approvals"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.pairing"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("does not treat operator.admin as satisfying non-operator scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["system.run"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
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
    expect(
      roleScopesAllow({
        role: " node ",
        requestedScopes: [" system.run ", "system.run", "  "],
        allowedScopes: ["system.run", "operator.admin"],
      }),
    ).toBe(true);
  });

  it("normalizes blank and duplicate scopes before evaluating", () => {
    expect(
      roleScopesAllow({
        role: " operator ",
        requestedScopes: [" operator.read ", "operator.read", "   "],
        allowedScopes: [" operator.write ", "operator.write", ""],
      }),
    ).toBe(true);
  });

  it("enforces full operator scope hierarchy: read < write < admin", () => {
    // admin satisfies all lower scopes
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read", "operator.write"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);

    // write satisfies read but not admin
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
        requestedScopes: ["operator.admin"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe(false);

    // read does not satisfy write or admin
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.admin"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(false);
  });

  it("rejects unsatisfied operator write scopes and empty allowed scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["   "],
      }),
    ).toBe(false);
  });
});
