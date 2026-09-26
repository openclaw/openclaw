import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { readGatewayToolOperatorScopes } from "./gateway.js";

describe("admitted operator scope presentation", () => {
  it("leaves local/system calls unclassified", () => {
    expect(readGatewayToolOperatorScopes()).toBeUndefined();
  });
  it.each([
    { scopes: [] },
    { scopes: ["operator.write"] },
    { scopes: ["operator.sessions.write"] },
    { scopes: ["operator.admin"] },
  ])("returns an independent copy of admitted scopes $scopes", async ({ scopes }) => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "reviewer",
      scopes,
      assertCurrent: () => {},
    });
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:test", operatorAuthority: authority },
      () => {
        expect(readGatewayToolOperatorScopes()).toEqual(scopes);
        expect(readGatewayToolOperatorScopes()).not.toBe(authority.scopes);
      },
    );
  });
  it("does not report revoked source permissions", async () => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "reviewer",
      scopes: ["operator.admin"],
      assertCurrent: () => {
        throw new Error("revoked");
      },
    });
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:test", operatorAuthority: authority },
      () => {
        expect(() => readGatewayToolOperatorScopes()).toThrow("revoked");
      },
    );
  });
});
