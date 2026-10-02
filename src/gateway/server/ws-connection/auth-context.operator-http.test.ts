import { describe, expect, test, vi } from "vitest";
import type { GatewayAuthResult } from "../../auth.js";
import { resolveConnectAuthDecision } from "./auth-context.js";

describe("required operator device-token authentication", () => {
  test.each<NonNullable<GatewayAuthResult["method"]>>([
    "none",
    "token",
    "trusted-proxy",
    "tailscale",
  ])(
    "verifies the explicit device credential instead of inheriting %s authority",
    async (method) => {
      for (const valid of [false, true]) {
        const verifyDeviceToken = vi.fn(async () => ({
          ok: valid,
          reason: valid ? undefined : "token-mismatch",
        }));
        const verifyBootstrapToken = vi.fn(async () => ({ ok: true }));
        const decision = await resolveConnectAuthDecision({
          state: {
            authResult: { ok: true, method, user: "ambient@example.test" },
            authOk: true,
            authMethod: method,
            sharedAuthOk: true,
            pendingSharedAuthFailure: false,
            deviceTokenCandidate: "explicit-device-token",
            deviceTokenCandidateSource: "explicit-device-token",
            bootstrapTokenCandidate: "must-not-replace-device-proof",
          },
          requireDeviceToken: true,
          hasDeviceIdentity: true,
          deviceId: "paired-device",
          publicKey: "paired-public-key",
          role: "operator",
          scopes: ["operator.read"],
          verifyDeviceToken,
          verifyBootstrapToken,
        });
        expect(verifyDeviceToken).toHaveBeenCalledExactlyOnceWith({
          deviceId: "paired-device",
          token: "explicit-device-token",
          role: "operator",
          scopes: ["operator.read"],
        });
        expect(verifyBootstrapToken).not.toHaveBeenCalled();
        expect(decision.authOk).toBe(valid);
        expect(decision.authResult.user).toBeUndefined();
        if (valid) {
          expect(decision.authResult).toEqual({ ok: true, method: "device-token" });
          expect(decision.authMethod).toBe("device-token");
        }
      }
    },
  );
});
