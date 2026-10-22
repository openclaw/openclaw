import { expect, it } from "vitest";
import {
  intersectOperatorScopes as intersect,
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

function allows(role: string, requestedScopes: string[], allowedScopes: string[]) {
  return roleScopesAllow({ role, requestedScopes, allowedScopes });
}
const operator = (scopes: string[]) => scopes.map((scope) => `operator.${scope}`);

it("does not broaden session write authority to general writes", () => {
  expect(allows("operator", ["operator.write"], ["operator.sessions.write"])).toBe(false);
});

it("caps full write to non-enrolling write without granting enrollment back", () => {
  const restricted = "operator.write.no-credential-enrollment";
  expect(allows("operator", [restricted], ["operator.write"])).toBe(true);
  expect(allows("operator", ["operator.write"], [restricted])).toBe(false);
  expect(
    allows(
      "operator",
      ["operator.read.no-credential-enrollment", "operator.talk", "operator.sessions.write"],
      [restricted],
    ),
  ).toBe(true);
  expect(allows("operator", ["operator.read"], [restricted])).toBe(false);
  expect(intersect(["operator.read"], [restricted])).toEqual([
    "operator.read.no-credential-enrollment",
  ]);
  expect(intersect(["operator.write"], [restricted])).toEqual([restricted]);
  expect(intersect([restricted], ["operator.write"])).toEqual([restricted]);
  expect(allows("operator", ["operator.write"], [restricted, "operator.write"])).toBe(true);
});

it("keeps ordinary read attenuation read-only and enrollment-free", () => {
  const read = "operator.read.no-credential-enrollment";
  expect(allows("operator", [read], ["operator.read"])).toBe(true);
  for (const requested of [
    "operator.read",
    "operator.write",
    "operator.write.no-credential-enrollment",
  ]) {
    expect(allows("operator", [requested], [read])).toBe(false);
  }
  expect(allows("operator", ["operator.sessions.read"], [read])).toBe(true);
  expect(intersect(["operator.read"], ["operator.write.no-credential-enrollment"])).toEqual([read]);
});

it.each([
  [["read", "write"], ["sessions.write"], ["sessions.write"]],
  [["admin"], ["sessions.read"], ["sessions.read"]],
  [["read"], ["sessions.write"], ["sessions.read"]],
  [["sessions.write"], ["read"], ["sessions.read"]],
  [[], ["sessions.write"], []],
  [["write"], ["write"], ["write"]],
])("intersects operator grants %j with ceiling %j", (grants, ceiling, expected) => {
  expect(intersect(operator(grants), operator(ceiling))).toEqual(operator(expected));
});
it("treats operator.talk as satisfied by talk/write/admin scopes", () => {
  for (const allowedScope of ["operator.talk", "operator.write", "operator.admin"]) {
    expect(allows("operator", ["operator.talk"], [allowedScope])).toBe(true);
  }
  expect(allows("operator", ["operator.talk"], ["operator.read"])).toBe(false);
});

it("requires an exact grant or admin for operator.talk.secrets", () => {
  for (const grants of [["operator.talk.secrets"], ["operator.admin"]]) {
    expect(allows("operator", ["operator.talk.secrets"], grants)).toBe(true);
  }
  for (const grants of [[], ["operator.write"]]) {
    expect(allows("operator", ["operator.talk.secrets"], grants)).toBe(false);
  }
});

it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
  expect(allows("node", ["node.exec"], ["operator.admin", "node.exec"])).toBe(true);
  expect(allows("node", ["node.exec"], ["operator.admin"])).toBe(false);
  expect(allows("node", ["operator.read"], ["operator.read", "node.exec"])).toBe(false);
  expect(
    allows(" node ", [" node.exec ", "node.exec", "  "], ["node.exec", "operator.admin"]),
  ).toBe(true);
});

it("returns the original first missing scope for a whitespace-padded role", () => {
  const params = {
    role: " node ",
    requestedScopes: [" \t", " node.exec ", "node.exec", " node.read \t", "operator.read"],
    allowedScopes: [" node.exec ", "node.exec", ""],
  };
  expect(resolveMissingRequestedScope(params)).toBe(" node.read \t");
  expect(roleScopesAllow(params)).toBe(false);
});

it.each([
  [["node", "operator"], ["", " \t", "node.exec", "operator.read"], null],
  [["node", "operator"], ["node.exec", " vault.admin \t", "operator.read"], " vault.admin \t"],
  [[], ["", "node.exec"], ""],
] satisfies [string[], string[], string | null][])(
  "finds the first scope outside roles %j among %j",
  (requestedRoles, requestedScopes, expected) => {
    expect(resolveScopeOutsideRequestedRoles({ requestedRoles, requestedScopes })).toBe(expected);
  },
);

it("excludes grants outside the operator ceiling", () => {
  expect(intersect(["node.exec"], ["operator.admin"])).toEqual([]);
});
