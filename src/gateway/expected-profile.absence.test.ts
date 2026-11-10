import { expect, it, vi } from "vitest";
import { createExpectedProfileBinding } from "./expected-profile.js";
import type { GatewayClient } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

it("distinguishes an omitted profile precondition from captured absence", async () => {
  const client = { connect: gatewayConnect(["operator.admin"]) };
  expect(await createExpectedProfileBinding(undefined, client)).toBeUndefined();
  const binding = await createExpectedProfileBinding(null, client);
  expect(binding).toBeDefined();
  expect(() => binding?.assertCurrent()).not.toThrow();
  expect(() => binding?.assertMatchesResolvedProfile(undefined)).not.toThrow();
});

it.each(["profile", "pending identity"])(
  "rejects %s appearing after captured absence",
  async (change) => {
    const client: GatewayClient = { connect: gatewayConnect(["operator.admin"]) };
    const binding = await createExpectedProfileBinding(null, client);
    if (change === "profile") {
      client.authenticatedUserProfile = gatewayProfile("selected-profile");
    } else {
      client.authenticatedUserId = "pending-identity";
    }
    expect(() => binding?.assertCurrent()).toThrow("Selected account changed");
    expect(() => binding?.assertMatchesResolvedProfile(undefined)).toThrow(
      "Selected account changed",
    );
    const respond = vi.fn();
    binding?.guardResponse(respond)(true, {});
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
      }),
    );
  },
);
