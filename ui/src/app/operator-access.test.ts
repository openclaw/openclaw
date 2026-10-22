// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  canReactToSession,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
  readGatewayOperatorAccess,
} from "./operator-access.ts";

describe("readGatewayOperatorAccess", () => {
  it.each([
    {
      name: "an absent snapshot",
      snapshot: null,
      expected: [true, true, false, true, false],
    },
    {
      name: "an absent hello",
      snapshot: { hello: null },
      expected: [true, true, false, true, false],
    },
    {
      name: "legacy operator authentication",
      snapshot: { hello: { auth: { role: "operator" } } },
      expected: [true, true, true, true, true],
    },
    {
      name: "explicitly empty scopes",
      snapshot: { hello: { auth: { role: "operator", scopes: [] } } },
      expected: [false, false, false, false, false],
    },
    {
      name: "read-only access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.read"] } } },
      expected: [false, false, false, false, false],
    },
    {
      name: "write access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.write"] } } },
      expected: [true, false, false, false, false],
    },
    {
      name: "write access without personal credential enrollment",
      snapshot: {
        hello: { auth: { role: "operator", scopes: ["operator.write.no-credential-enrollment"] } },
      },
      expected: [true, false, false, false, false],
    },
    {
      name: "approval access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.approvals"] } } },
      expected: [false, false, false, true, true],
    },
    {
      name: "pairing access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.pairing"] } } },
      expected: [false, false, true, false, false],
    },
    {
      name: "administrator access",
      snapshot: { hello: { auth: { role: "operator", scopes: ["operator.admin"] } } },
      expected: [true, true, true, true, true],
    },
    {
      name: "a foreign role with an operator scope",
      snapshot: { hello: { auth: { role: "node", scopes: ["node.read", "operator.admin"] } } },
      expected: [false, false, false, false, false],
    },
  ])("projects $name from the current Gateway snapshot", ({ snapshot, expected }) => {
    expect(
      readGatewayOperatorAccess(snapshot as Pick<ApplicationGatewaySnapshot, "hello"> | null),
    ).toEqual({
      canWrite: expected[0],
      canAdmin: expected[1],
      canPair: expected[2],
      canReviewApprovals: expected[3],
      canGrantApprovals: expected[4],
    });
  });
});

describe("hasOperatorReadAccess", () => {
  it("accepts read, implied write/admin, and legacy access but rejects unrelated scopes", () => {
    expect(hasOperatorReadAccess(null)).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.read"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.write"] })).toBe(true);
    expect(
      hasOperatorReadAccess({
        role: "operator",
        scopes: ["operator.read.no-credential-enrollment"],
      }),
    ).toBe(true);
    expect(
      hasOperatorReadAccess({
        role: "operator",
        scopes: ["operator.write.no-credential-enrollment"],
      }),
    ).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.admin"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator" })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.pairing"] })).toBe(false);
  });
});

it("keeps provider enrollment strict while ordinary profile writes accept the restricted grant", () => {
  for (const scopes of [
    ["operator.write.no-credential-enrollment"],
    ["operator.write"],
    ["operator.admin"],
    ["operator.write.no-credential-enrollment", "operator.write"],
  ]) {
    const auth = { role: "operator", scopes };
    expect(hasOperatorWriteAccess(auth)).toBe(true);
    for (const method of ["users.authConnect.start", "users.authConnect.answer"]) {
      expect(hasOperatorWriteAccess(auth, method)).toBe(
        scopes.includes("operator.write") || scopes.includes("operator.admin"),
      );
    }
  }
});

it("separates ordinary reads from GitHub credential enrollment without subtracting legacy grants", () => {
  for (const scopes of [
    ["operator.read.no-credential-enrollment"],
    ["operator.write.no-credential-enrollment"],
    ["operator.read"],
    ["operator.write"],
    ["operator.admin"],
    ["operator.write.no-credential-enrollment", "operator.read"],
  ]) {
    const auth = { role: "operator", scopes };
    expect(hasOperatorReadAccess(auth, "users.github.status")).toBe(true);
    expect(hasOperatorReadAccess(auth, "users.github.disconnect")).toBe(true);
    for (const method of ["users.github.authorize.start", "users.github.authorize.poll"]) {
      expect(hasOperatorReadAccess(auth, method)).toBe(
        scopes.some((scope) =>
          ["operator.read", "operator.write", "operator.admin"].includes(scope),
        ),
      );
    }
  }
});

// The hello cap and row role are independent grants; neither can substitute for the other.
describe("canReactToSession", () => {
  const client = createTestGatewayClient(() => ({}));
  const snapshot = (sessionCap?: "none" | "view" | "suggest" | "write") => ({
    phase: "connected" as const,
    client,
    hello: {
      ...gatewayHelloForMethods(["session.reactions.set"], ["operator.write"]),
      auth: { role: "operator", scopes: ["operator.write"], sessionCap },
    },
  });
  const options = { archived: false, catalog: false };

  it.each([
    ["owner", "shared", undefined, true],
    ["admin", "draft", "write", true],
    ["owner", "draft", "view", true],
    ["member", "draft", undefined, false],
    ["member", "read-only", "view", true],
    ["viewer", "shared", undefined, true],
    ["viewer", "shared", "write", true],
    ["viewer", "shared", "suggest", false],
    ["viewer", "shared", "view", false],
    ["viewer", "suggest", "suggest", true],
    ["viewer", "suggest", undefined, true],
    ["viewer", "suggest", "view", false],
    ["viewer", "read-only", "write", false],
    ["viewer", "draft", "write", false],
    ["owner", "shared", "none", false],
    ["admin", "draft", "none", false],
  ] as const)("%s in %s with cap %s: %s", (sharingRole, visibility, cap, allowed) => {
    expect(canReactToSession(snapshot(cap), { sharingRole, visibility }, options)).toBe(allowed);
  });

  it("requires the advertised write action for an admitted, active local session", () => {
    const session = { sharingRole: "owner" as const, visibility: "shared" as const };
    const current = snapshot();
    const retired = createTestGatewayClient(() => ({}));
    retired.retireOfflineRecoveryScope();
    for (const denied of [
      { ...current, phase: "offline" as const, client: retired },
      { ...current, client: null },
      { ...current, hello: gatewayHelloForMethods([], ["operator.write"]) },
      { ...current, hello: gatewayHelloForMethods(["session.reactions.set"], ["operator.read"]) },
    ]) {
      expect(canReactToSession(denied, session, options)).toBe(false);
    }
    expect(canReactToSession(current, session, { ...options, catalog: true })).toBe(false);
    expect(canReactToSession(current, session, { ...options, archived: true })).toBe(false);
    expect(canReactToSession(current, undefined, options)).toBe(false);
    for (const phase of ["offline", "reconnecting"] as const) {
      expect(canReactToSession({ ...current, phase }, session, options)).toBe(true);
    }
    expect(canReactToSession({ ...current, phase: "stopped" }, session, options)).toBe(false);
  });
});
