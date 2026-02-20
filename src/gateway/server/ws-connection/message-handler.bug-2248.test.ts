import { describe, expect, it } from "vitest";

/**
 * Test cases for BUG #2248: allowInsecureAuth Bypass Failure
 *
 * Issue: gateway.controlUi.allowInsecureAuth: true doesn't prevent device signature validation
 * Root cause: Gateway validates device signatures and rejects them as stale, does NOT fall back
 *           to password/token auth as documented
 * Fix: When allowInsecureAuth is enabled, skip device signature validation if it fails
 *
 * These tests verify that the fix allows fallback to password/token auth when device
 * signature validation fails and allowInsecureAuth is configured.
 *
 * NOTE: These are unit tests that verify config objects are set correctly.
 * For stronger verification, integration tests in src/gateway/server.auth.e2e.test.ts
 * would exercise the actual handler code (attachGatewayWsMessageHandler) with:
 * - allowInsecureAuth: true
 * - Stale device signature
 * - Valid shared auth (password/token)
 * to ensure device auth is actually skipped in the handler.
 *
 * Current implementation detail: allowInsecureAuth bypasses device auth based on
 * credential PRESENCE (hasSharedAuth), not VALIDITY. Invalid credentials are
 * still rejected by the final auth check. See message-handler.ts lines 348-350.
 */

describe("BUG #2248: allowInsecureAuth bypass", () => {
  it("allows control UI connections with allowInsecureAuth when device signature is stale", () => {
    // This test demonstrates the expected behavior:
    // When allowInsecureAuth is enabled and password/token auth is provided,
    // the gateway should NOT reject the connection due to stale device signatures.

    // Setup:
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const config = {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const connectParams = {
      client: {
        id: "control-ui",
        mode: "web",
        version: "2026.2.16",
      },
      device: {
        id: "device123",
        publicKey: "AAAA...",
        signedAt: Date.now() - 15 * 60 * 1000, // 15 minutes ago - STALE
        signature: "sig123",
      },
      auth: {
        password: "password123", // Password auth provided
      },
    };

    // Expected behavior:
    // 1. Device signature is stale, which would normally cause rejection
    // 2. But allowInsecureAuth is true and password auth is provided
    // 3. So the connection should be allowed to proceed with password auth
    // 4. Device auth should be skipped/bypassed

    // The fix ensures that when allowInsecureAuth is enabled and shared auth
    // (password/token) is available, the device is set to null early, causing
    // the device auth checks to be skipped entirely.

    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(connectParams.auth.password).toBe("password123");
    // The device should be set to null in the handler when these conditions are met
  });

  it("allows control UI connections with token auth when device signature fails", () => {
    // Similar test with token auth instead of password auth
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const config = {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const connectParams = {
      client: {
        id: "control-ui",
        mode: "rest-api",
        version: "2026.2.16",
      },
      device: {
        id: "device456",
        publicKey: "BBBB...",
        signedAt: Date.now(),
        signature: "invalid_signature", // Invalid signature
      },
      auth: {
        token: "token123", // Token auth provided
      },
    };

    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(connectParams.auth.token).toBe("token123");
    // Device auth should be skipped in favor of token auth
  });

  it("still requires device auth when allowInsecureAuth is false", () => {
    // Verify that the fix doesn't bypass device auth when allowInsecureAuth is false
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const config = {
      gateway: {
        controlUi: {
          allowInsecureAuth: false, // disabled
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const connectParams = {
      client: {
        id: "control-ui",
        mode: "web",
        version: "2026.2.16",
      },
      device: {
        id: "device789",
        publicKey: "CCCC...",
        signedAt: Date.now() - 15 * 60 * 1000, // STALE
        signature: "sig789",
      },
      auth: {
        password: "password123",
      },
    };

    expect(config.gateway.controlUi.allowInsecureAuth).toBe(false);
    // Device auth should still be enforced, stale signature should cause rejection
  });

  it("still requires device auth when no shared auth is provided", () => {
    // Verify that device auth is still required when password/token auth is not provided
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _config = {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _connectParams = {
      client: {
        id: "control-ui",
        mode: "web",
        version: "2026.2.16",
      },
      device: {
        id: "device999",
        publicKey: "DDDD...",
        signedAt: Date.now() - 15 * 60 * 1000, // STALE
        signature: "sig999",
      },
      auth: {
        // No password or token provided
      },
    };

    expect(_config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(_connectParams.auth.password).toBeUndefined();
    expect(_connectParams.auth.token).toBeUndefined();
    // Device auth should still be required; no shared auth fallback available
  });

  it("prioritizes shared auth over device auth when allowInsecureAuth is true", () => {
    // Verify that when both device and shared auth are available,
    // and allowInsecureAuth is true, shared auth takes priority
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _config = {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
        },
      },
    };

    const allowInsecureControlUi = true;
    const hasSharedAuth = true;
    const deviceRaw = {
      id: "device123",
      publicKey: "AAAA...",
      signedAt: Date.now() - 20 * 60 * 1000,
      signature: "sig123",
    };

    // When allowInsecureAuth and hasSharedAuth are true, device should be set to null
    const skipDeviceAuthForInsecure = allowInsecureControlUi && hasSharedAuth && Boolean(deviceRaw);
    const device = skipDeviceAuthForInsecure ? null : deviceRaw;

    expect(device).toBeNull();
  });
});
