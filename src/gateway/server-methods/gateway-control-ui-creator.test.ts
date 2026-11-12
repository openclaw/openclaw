import { describe, expect, it } from "vitest";
import type { GatewayClient } from "./client-types.js";
import { isAttendedControlUiSessionCreator } from "./gateway-personal-caller.js";

const direct = {
  authenticatedUserProfile: { profileId: "synthetic-human" },
  connect: { role: "operator" },
  internal: { authenticatedControlUi: true, authenticatedOperator: true },
};
const qualifies = (value: unknown) => isAttendedControlUiSessionCreator(value as GatewayClient);

describe("confidential default control UI identity boundary", () => {
  it("accepts the authenticated direct human profile", () => {
    expect(qualifies(direct)).toBe(true);
  });
  it.each([
    { ...direct, authenticatedUserProfile: undefined },
    { ...direct, authenticatedUserProfile: { profileId: "gateway-owner" } },
    { ...direct, internal: { ...direct.internal, authenticatedControlUi: false } },
    { ...direct, internal: { ...direct.internal, authenticatedOperator: false } },
    { ...direct, internal: { ...direct.internal, syntheticClient: true } },
    { ...direct, internal: { ...direct.internal, remoteIngressPrincipal: {} } },
    { ...direct, connect: { role: "node" } },
  ])("rejects unprofiled, technical, delegated or non-Control-UI callers", (caller) => {
    expect(qualifies(caller)).toBe(false);
  });
});
