import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMIT_CLIENT_KEY_BROWSER_ORIGIN_PREFIX } from "../../auth-rate-limit.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import {
  resolveHandshakeBrowserSecurityContext,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
} from "./handshake-auth-helpers.js";

function createRateLimiter(): AuthRateLimiter {
  return {
    check: () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }),
    reset: () => {},
    recordFailure: () => {},
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

describe("handshake auth helpers", () => {
  it("keys browser-origin loopback clients by origin for rate limiting", () => {
    const rateLimiter = createRateLimiter();
    const browserRateLimiter = createRateLimiter();
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "https://App.Example:443",
      clientIp: "127.0.0.1",
      rateLimiter,
      browserRateLimiter,
    });

    expect(resolved).toMatchObject({
      hasBrowserOriginHeader: true,
      enforceOriginCheckForAnyClient: true,
      rateLimitClientIp: `${AUTH_RATE_LIMIT_CLIENT_KEY_BROWSER_ORIGIN_PREFIX}https://app.example:443`,
      authRateLimiter: browserRateLimiter,
    });
  });

  it("recommends device-token retry only for shared-token mismatch with device identity", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { token: "shared-token" },
      failedAuth: { ok: false, reason: "token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "token",
      canRetryWithDeviceToken: true,
      recommendedNextStep: "retry_with_device_token",
    });
  });

  it("treats explicit device-token mismatch as credential update guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "device_token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "update_auth_credentials",
    });
  });

  it("allows silent local pairing for not-paired, scope-upgrade and role-upgrade", () => {
    expect(
      shouldAllowSilentLocalPairing({
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "role-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "metadata-upgrade",
      }),
    ).toBe(false);
  });

  it("rejects silent role-upgrade for remote clients", () => {
    expect(
      shouldAllowSilentLocalPairing({
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "role-upgrade",
      }),
    ).toBe(false);
  });
});
