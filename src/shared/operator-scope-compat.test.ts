// Role scope checks preserve operator implications and role-prefix boundaries.
import { describe, expect, it } from "vitest";
import {
  intersectOperatorScopes,
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

function allows(role: string, requestedScopes: string[], allowedScopes: string[]) {
  return roleScopesAllow({ role, requestedScopes, allowedScopes });
}

describe("roleScopesAllow", () => {
  it.each([["operator.sessions.write", "operator.write", false]])(
    "checks grant %s against %s without broadening session authority",
    (grant, requested, allowed) => {
      expect(
        roleScopesAllow({ role: "operator", requestedScopes: [requested], allowedScopes: [grant] }),
      ).toBe(allowed);
    },
  );

  it("derives an explicitly selected session ceiling from existing grants without inventing write access", () => {
    expect(
      intersectOperatorScopes(["operator.read", "operator.write"], ["operator.sessions.write"]),
    ).toEqual(["operator.sessions.write"]);
    expect(intersectOperatorScopes(["operator.admin"], ["operator.sessions.read"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersectOperatorScopes(["operator.read"], ["operator.sessions.write"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersectOperatorScopes(["operator.sessions.write"], ["operator.read"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersectOperatorScopes([], ["operator.sessions.write"])).toEqual([]);
    expect(intersectOperatorScopes(["operator.write"], ["operator.write"])).toEqual([
      "operator.write",
    ]);
  });
  it("treats operator.talk as satisfied by talk/write/admin scopes", () => {
    for (const allowedScope of ["operator.talk", "operator.write", "operator.admin"]) {
      expect(allows("operator", ["operator.talk"], [allowedScope])).toBe(true);
    }
    expect(allows("operator", ["operator.talk"], ["operator.read"])).toBe(false);
  });

  it.each(["operator.talk.secrets"])(
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

  it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
    expect(allows("node", ["node.exec"], ["operator.admin", "node.exec"])).toBe(true);
    expect(allows("node", ["node.exec"], ["operator.admin"])).toBe(false);
    expect(allows("node", ["operator.read"], ["operator.read", "node.exec"])).toBe(false);
    expect(
      allows(" node ", [" node.exec ", "node.exec", "  "], ["node.exec", "operator.admin"]),
    ).toBe(true);
  });

  it.each([
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

  it.each([{ requestedScopes: ["", "node.exec"], outsideScope: "" }])(
    "returns the first scope with no requested roles: $requestedScopes",
    ({ requestedScopes, outsideScope }) => {
      expect(resolveScopeOutsideRequestedRoles({ requestedRoles: [], requestedScopes })).toBe(
        outsideScope,
      );
    },
  );
});

describe("intersectOperatorScopes", () => {
  it.each([{ grant: ["node.exec"], ceiling: ["operator.admin"], expected: [] }])(
    "narrows $grant to capabilities within $ceiling",
    ({ grant, ceiling, expected }) => {
      expect(intersectOperatorScopes(grant, ceiling)).toEqual(expected);
    },
  );
});
