import { expect } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import type { GatewayClient } from "../../server-methods/client-types.js";
import { attachGatewayHarness } from "./message-handler.post-connect-health.test-support.js";

/** Token admission retains owner identity; device-less unauthenticated probes stay rejected. */
export async function expectEphemeralOwnerConnect(
  mode: "cli" | "backend" | "probe",
  authMethod: "token" | "none",
): Promise<void> {
  const harness = attachGatewayHarness({
    connId: `ephemeral-${mode}`,
    connectNonce: `nonce-${mode}`,
    resolvedAuth: { mode: authMethod, token: "owner-fixture", allowTailscale: false },
  });
  harness.sendConnect("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "dev", platform: "test", mode },
    role: "operator",
    ...(authMethod === "token" ? { auth: { token: "owner-fixture" } } : {}),
    caps: [],
  });
  await harness.runWhenIdle();
  if (authMethod === "none") {
    expect(harness.frames).toContainEqual(
      expect.objectContaining({
        id: "connect",
        ok: false,
        error: expect.objectContaining({
          message: "device identity required",
          details: { code: "DEVICE_IDENTITY_REQUIRED" },
        }),
      }),
    );
    expect(harness.client).toBeNull();
    expect(harness.registeredProfileId).toBeUndefined();
    return;
  }
  expect(harness.frames).toContainEqual(expect.objectContaining({ id: "connect", ok: true }));
  expect(harness.client).toMatchObject({
    authenticatedUserProfile: { profileId: GATEWAY_OWNER_PROFILE_ID },
    connect: { scopes: [] },
    internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
  });
  expect(harness.registeredProfileId).toBe(GATEWAY_OWNER_PROFILE_ID);
  expect(harness.client).not.toHaveProperty("authenticatedUserId");
}

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
