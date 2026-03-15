import { describe, expect, it } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/index.js";
import {
  BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP,
  resolveHandshakeBrowserSecurityContext,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipBackendSelfPairing,
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
  it("pins browser-origin loopback clients to the synthetic rate-limit ip", () => {
    const rateLimiter = createRateLimiter();
    const browserRateLimiter = createRateLimiter();
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "https://app.example",
      clientIp: "127.0.0.1",
      rateLimiter,
      browserRateLimiter,
    });

    expect(resolved).toMatchObject({
      hasBrowserOriginHeader: true,
      enforceOriginCheckForAnyClient: true,
      rateLimitClientIp: BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP,
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

  it("allows silent local pairing only for not-paired and scope upgrades", () => {
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
        reason: "metadata-upgrade",
      }),
    ).toBe(false);
  });

  it("skips backend self-pairing for local trusted backend clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;

    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(true);
    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "device-token",
      }),
    ).toBe(true);
    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(false);
  });

  it("skips backend self-pairing when authMode is none for local backend clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;

    // Local backend client with authMode "none" should bypass pairing
    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "none",
        authMode: "none",
      }),
    ).toBe(true);
  });

  it("rejects non-backend clients even when authMode is none", () => {
    const connectParams = {
      client: {
        id: "some-other-client",
        mode: "interactive",
      },
    } as unknown as ConnectParams;

    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "none",
        authMode: "none",
      }),
    ).toBe(false);
  });

  it("rejects remote backend clients even when authMode is none", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;

    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "none",
        authMode: "none",
      }),
    ).toBe(false);
  });

  it("rejects backend clients with browser origin even when authMode is none", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;

    expect(
      shouldSkipBackendSelfPairing({
        connectParams,
        isLocalClient: true,
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authMethod: "none",
        authMode: "none",
      }),
    ).toBe(false);
  });
});
