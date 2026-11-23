import { afterEach, expect, it, vi } from "vitest";
import * as tokens from "../../../infra/device-pairing-tokens.js";
import {
  completeGatewayConnectDeviceTokens,
  createGatewayConnectDeviceTokenPreparation,
} from "./connect-device-tokens.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("fences person-bound credential publication when the profile row ends", async () => {
  let current = true;
  const state: Parameters<typeof createGatewayConnectDeviceTokenPreparation>[1] &
    Parameters<typeof completeGatewayConnectDeviceTokens>[0] = {
    role: "operator",
    authResult: { ok: true, user: "person@example.test" },
    device: {
      id: "device",
      publicKey: "key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
    isControlUi: false,
    isBrowserOperatorUi: false,
    isWebchat: false,
    trustedProxyAuthOk: false,
    sessionUsesSharedGatewayAuth: false,
    handoffBootstrapProfile: null,
    scopes: ["operator.admin"],
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
  const context: Parameters<typeof createGatewayConnectDeviceTokenPreparation>[0] = {
    configSnapshot: { gateway: { openclawId: { enabled: true }, roles: { definitions: {} } } },
    hasBrowserOriginHeader: false,
    handler: { ingressAttribution: { kind: "direct" } },
  };
  const issue = vi.spyOn(tokens, "ensureDeviceToken").mockImplementation(async (params) => {
    expect(params.isIssuanceCurrent?.()).toBe(true);
    current = false;
    expect(params.isIssuanceCurrent?.()).toBe(false);
    return null;
  });
  state.prepareDeviceTokens = createGatewayConnectDeviceTokenPreparation(context, state, true);
  const prepared = completeGatewayConnectDeviceTokens(state, {
    profileId: "person",
    openclawIdAccountIds: ["account"],
    isCurrent: () => current,
  });
  await expect(prepared).rejects.toThrow("Device token issuance ended. Reconnect to retry.");
  expect(issue).toHaveBeenCalledOnce();
  expect(state.deviceToken).toBeNull();
  expect(state.bootstrapDeviceTokens).toEqual([]);
});
