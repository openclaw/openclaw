import { afterEach, expect, it, vi } from "vitest";
import * as tokens from "../../../infra/device-pairing-tokens.js";
import { setOpenClawIdMemberAccountLookup } from "../../openclaw-id/tunnel-principal.js";
import {
  completeGatewayConnectDeviceTokens,
  createGatewayConnectDeviceTokenPreparation,
} from "./connect-device-tokens.js";

afterEach(() => {
  setOpenClawIdMemberAccountLookup(undefined);
  vi.restoreAllMocks();
});

it.each(["membership", "profile", "delivery", "after-prepare"] as const)(
  "fences person-bound credential publication on a %s change",
  async (change) => {
    let member = false;
    let current = true;
    setOpenClawIdMemberAccountLookup((accountId) => member && accountId === "account");
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
      if (change === "profile") {
        current = false;
      } else if (change !== "after-prepare") {
        member = true;
      }
      if (change !== "delivery" && change !== "after-prepare") {
        expect(params.isIssuanceCurrent?.()).toBe(false);
        return null;
      }
      return {
        token: "synthetic-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      };
    });
    state.prepareDeviceTokens = createGatewayConnectDeviceTokenPreparation(
      context,
      state,
      true,
      () => true,
    );
    const prepared = completeGatewayConnectDeviceTokens(state, {
      profileId: "person",
      openclawIdAccountIds: ["account"],
      isCurrent: () => current,
    });
    if (change === "after-prepare") {
      await prepared;
      expect(state.isDeviceTokenSubjectCurrent?.()).toBe(true);
      member = true;
      expect(state.isDeviceTokenSubjectCurrent?.()).toBe(false);
      expect(state.deviceToken?.token).toBe("synthetic-token");
      return;
    }
    await expect(prepared).rejects.toThrow("membership changed during device token issuance");
    expect(issue).toHaveBeenCalledOnce();
    expect(state.deviceToken).toBeNull();
    expect(state.bootstrapDeviceTokens).toEqual([]);
  },
);
