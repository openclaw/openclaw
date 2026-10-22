// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  canReactToSession,
  hasOperatorReadAccess,
  readGatewayOperatorAccess,
} from "./operator-access.ts";

const operator = (scopes?: string[], role = "operator") => ({ hello: { auth: { role, scopes } } });

describe("readGatewayOperatorAccess", () => {
  it.each([
    ["an absent snapshot", null, [true, true, false, true, false]],
    ["an absent hello", { hello: null }, [true, true, false, true, false]],
    ["legacy operator authentication", operator(), [true, true, true, true, true]],
    ["explicitly empty scopes", operator([]), [false, false, false, false, false]],
    ["read-only access", operator(["operator.read"]), [false, false, false, false, false]],
    ["write access", operator(["operator.write"]), [true, false, false, false, false]],
    ["approval access", operator(["operator.approvals"]), [false, false, false, true, true]],
    ["pairing access", operator(["operator.pairing"]), [false, false, true, false, false]],
    ["administrator access", operator(["operator.admin"]), [true, true, true, true, true]],
    [
      "a foreign role",
      operator(["node.read", "operator.admin"], "node"),
      [false, false, false, false, false],
    ],
  ] as const)("projects %s from the current Gateway snapshot", (_name, snapshot, expected) => {
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
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.admin"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator" })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.pairing"] })).toBe(false);
  });
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
