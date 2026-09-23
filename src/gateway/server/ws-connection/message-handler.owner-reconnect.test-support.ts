import { expect } from "vitest";
import type { GatewayClient } from "../../server-methods/client-types.js";

/** Shared-owner reconnect identity, authentication, and scope invariants. */
export function expectAuthenticatedOwnerReconnect(
  value: unknown,
  options: {
    authMethod: "token" | "password" | "device-token" | "none";
    previousProfileId?: string;
    registeredProfileId?: string;
  },
): string {
  const client = value as GatewayClient;
  expect(client.authenticatedUserId).toBeUndefined();
  expect(client.internal?.authenticatedOperator).toBe(
    options.authMethod === "none" ? undefined : true,
  );
  const profileId = client.authenticatedUserProfile?.profileId;
  expect(options.registeredProfileId).toBe(profileId);
  expect(client.authenticatedUserProfile).toMatchObject({
    displayName: options.previousProfileId ? "Saved Owner" : "Gateway Person",
  });
  if (options.previousProfileId) {
    expect(profileId).toBe(options.previousProfileId);
  }
  expect(client.connect.scopes).toEqual(
    options.authMethod === "token" || options.authMethod === "password" ? [] : ["operator.read"],
  );
  if (!profileId) {
    throw new Error("Expected an authenticated owner profile");
  }
  return profileId;
}
