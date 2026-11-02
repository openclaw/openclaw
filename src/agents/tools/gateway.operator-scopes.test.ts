import { expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { readGatewayToolOperatorScopes } from "./gateway.js";

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
