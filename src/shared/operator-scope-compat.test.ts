// Role scope checks preserve operator implications and role-prefix boundaries.
import { describe, expect, it } from "vitest";
import {
  intersectOperatorScopes,
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

describe("roleScopesAllow", () => {
  it.each([
    { requestedScopes: [], allowedScopes: [] },
    { requestedScopes: ["", " \t"], allowedScopes: [] },
    { requestedScopes: ["", " \t"], allowedScopes: ["operator.admin"] },
  ])(
    "ignores empty and blank requests: $requestedScopes with grants $allowedScopes",
    ({ requestedScopes, allowedScopes }) => {
      const params = { role: "operator", requestedScopes, allowedScopes };
      expect(roleScopesAllow(params)).toBe(true);
      expect(resolveMissingRequestedScope(params)).toBeNull();
    },
  );

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

  it("treats operator.talk as satisfied by talk/write/admin scopes", () => {
    for (const allowedScope of ["operator.talk", "operator.write", "operator.admin"]) {
      expect(
        roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.talk"],
          allowedScopes: [allowedScope],
        }),
      ).toBe(true);
    }
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.talk"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(false);
  });

  it.each(["operator.talk.secrets", "operator.approvals", "operator.pairing", "operator.future"])(
    "requires an exact grant or admin for %s",
    (requestedScope) => {
      for (const allowedScopes of [[requestedScope], ["operator.admin"]]) {
        expect(
          roleScopesAllow({ role: "operator", requestedScopes: [requestedScope], allowedScopes }),
        ).toBe(true);
      }
      for (const allowedScopes of [[], ["operator.write"]]) {
        expect(
          roleScopesAllow({ role: "operator", requestedScopes: [requestedScope], allowedScopes }),
        ).toBe(false);
      }
    },
  );

  it("does not treat operator.admin as satisfying non-operator scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["system.run"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
  });

  it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["operator.admin", "node.exec"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.read", "node.exec"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: " node ",
        requestedScopes: [" node.exec ", "node.exec", "  "],
        allowedScopes: ["node.exec", "operator.admin"],
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

  it.each([
    {
      role: " operator ",
      requestedScopes: [
        "",
        " operator.read ",
        "operator.read",
        " operator.approvals \t",
        "operator.admin",
      ],
      allowedScopes: [" operator.write ", "operator.write", ""],
      missingScope: " operator.approvals \t",
    },
    {
      role: " node ",
      requestedScopes: [" \t", " node.exec ", "node.exec", " node.read \t", "operator.read"],
      allowedScopes: [" node.exec ", "node.exec", ""],
      missingScope: " node.read \t",
    },
  ])("returns the original first missing scope for $role", ({ missingScope, ...params }) => {
    expect(resolveMissingRequestedScope(params)).toBe(missingScope);
    expect(roleScopesAllow(params)).toBe(false);
  });

  it("returns null when all requested scopes are satisfied", () => {
    expect(
      resolveMissingRequestedScope({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["node.exec", "operator.admin"],
      }),
    ).toBeNull();
  });

  it("returns null when every requested scope belongs to one requested role", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["", " \t", "node.exec", "operator.read"],
      }),
    ).toBeNull();
  });

  it("returns the first scope outside the requested role set", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", " vault.admin \t", "operator.read"],
      }),
    ).toBe(" vault.admin \t");
  });

  it.each([
    { requestedScopes: [], outsideScope: null },
    { requestedScopes: ["", "node.exec"], outsideScope: "" },
    { requestedScopes: [" \t", "node.exec"], outsideScope: " \t" },
  ])(
    "returns the first scope with no requested roles: $requestedScopes",
    ({ requestedScopes, outsideScope }) => {
      expect(resolveScopeOutsideRequestedRoles({ requestedRoles: [], requestedScopes })).toBe(
        outsideScope,
      );
    },
  );
});

describe("intersectOperatorScopes", () => {
  it.each([
    { grant: ["operator.write"], ceiling: ["operator.read"], expected: ["operator.read"] },
    { grant: ["operator.admin"], ceiling: ["operator.write"], expected: ["operator.write"] },
    { grant: ["operator.read"], ceiling: ["operator.write"], expected: ["operator.read"] },
    { grant: ["operator.write"], ceiling: ["operator.talk"], expected: ["operator.talk"] },
    { grant: [], ceiling: ["operator.admin"], expected: [] },
    { grant: ["operator.admin"], ceiling: [], expected: [] },
    {
      grant: ["operator.write"],
      ceiling: ["operator.approvals", "operator.talk.secrets"],
      expected: [],
    },
    { grant: ["operator.future"], ceiling: ["operator.read", "operator.write"], expected: [] },
    { grant: ["operator.future"], ceiling: ["operator.admin"], expected: ["operator.future"] },
    { grant: ["node.exec"], ceiling: ["operator.admin"], expected: [] },
  ])("narrows $grant to capabilities within $ceiling", ({ grant, ceiling, expected }) => {
    expect(intersectOperatorScopes(grant, ceiling)).toEqual(expected);
  });

  it("preserves sufficient grants without expanding their implied scopes", () => {
    const grant = ["operator.read", "operator.write"];
    expect(intersectOperatorScopes(grant, ["operator.admin"])).toEqual(grant);
    expect(
      intersectOperatorScopes(["operator.write"], ["operator.write", "operator.read"]),
    ).toEqual(["operator.write"]);
  });
});
