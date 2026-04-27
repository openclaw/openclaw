import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const TRUSTED_PROXY_AUTH = {
  mode: "trusted-proxy" as const,
  trustedProxy: {
    userHeader: "x-forwarded-user",
  },
};

const TOKEN_AUTH = {
  mode: "token" as const,
  token: "test-token-123",
};

describe("resolveGatewayRuntimeConfig", () => {
  describe("trusted-proxy auth mode", () => {
    // This test validates BOTH validation layers:
    // 1. CLI validation in src/cli/gateway-cli/run.ts (line 246)
    // 2. Runtime config validation in src/gateway/server-runtime-config.ts (line 99)
    // Both must allow lan binding when authMode === "trusted-proxy"
    it.each([
      {
        name: "lan binding",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["192.168.1.1"],
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "loopback binding with 127.0.0.1 proxy",
        cfg: {
          gateway: {
            bind: "loopback" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["127.0.0.1"],
          },
        },
        expectedBindHost: "127.0.0.1",
      },
      {
        name: "loopback binding with ::1 proxy",
        cfg: {
          gateway: { bind: "loopback" as const, auth: TRUSTED_PROXY_AUTH, trustedProxies: ["::1"] },
        },
        expectedBindHost: "127.0.0.1",
      },
      {
        name: "loopback binding with loopback cidr proxy",
        cfg: {
          gateway: {
            bind: "loopback" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["127.0.0.0/8"],
          },
        },
        expectedBindHost: "127.0.0.1",
      },
    ])("allows $name", async ({ cfg, expectedBindHost }) => {
      const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe(expectedBindHost);
    });

    it.each([
      {
        name: "loopback binding without trusted proxies",
        cfg: {
          gateway: { bind: "loopback" as const, auth: TRUSTED_PROXY_AUTH, trustedProxies: [] },
        },
        expectedMessage:
          /gateway auth mode=trusted-proxy requires gateway\.trustedProxies to be configured[\s\S]*Fix: add "trustedProxies":/,
      },
      {
        name: "loopback binding without loopback trusted proxy",
        cfg: {
          gateway: {
            bind: "loopback" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["10.0.0.1"],
          },
        },
        expectedMessage:
          /gateway auth mode=trusted-proxy with bind=loopback requires gateway\.trustedProxies to include 127\.0\.0\.1[\s\S]*Fix: add "127\.0\.0\.1" to the gateway\.trustedProxies array/,
      },
      {
        name: "lan binding without trusted proxies",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: [],
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedMessage:
          /gateway auth mode=trusted-proxy requires gateway\.trustedProxies to be configured[\s\S]*Fix: add "trustedProxies":/,
      },
    ])("rejects $name", async ({ cfg, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789 })).rejects.toThrow(
        expectedMessage,
      );
    });
  });

  describe("token/password auth modes", () => {
    let originalToken: string | undefined;

    beforeEach(() => {
      originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    });

    afterEach(() => {
      if (originalToken !== undefined) {
        process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
      } else {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      }
    });

    it.each([
      {
        name: "lan binding with token",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TOKEN_AUTH,
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedAuthMode: "token",
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "loopback binding with explicit none auth",
        cfg: { gateway: { bind: "loopback" as const, auth: { mode: "none" as const } } },
        expectedAuthMode: "none",
        expectedBindHost: "127.0.0.1",
      },
    ])("allows $name", async ({ cfg, expectedAuthMode, expectedBindHost }) => {
      const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
      expect(result.authMode).toBe(expectedAuthMode);
      expect(result.bindHost).toBe(expectedBindHost);
    });

    it.each([
      {
        name: "token mode without token",
        cfg: { gateway: { bind: "lan" as const, auth: { mode: "token" as const } } },
        expectedMessage:
          "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
      },
      {
        name: "lan binding with explicit none auth",
        cfg: { gateway: { bind: "lan" as const, auth: { mode: "none" as const } } },
        expectedMessage: /refusing to bind gateway[\s\S]*Fix: run `openclaw config set gateway\.auth\.mode token`/,
      },
      {
        name: "loopback binding that resolves to non-loopback host",
        cfg: { gateway: { bind: "loopback" as const, auth: { mode: "none" as const } } },
        host: "0.0.0.0",
        expectedMessage: /gateway bind=loopback resolved to non-loopback host[\s\S]*Fix: remove the --host flag override/,
      },
      {
        name: "custom bind without customBindHost",
        cfg: { gateway: { bind: "custom" as const, auth: TOKEN_AUTH } },
        expectedMessage: /gateway\.bind=custom requires gateway\.customBindHost[\s\S]*Fix: add "customBindHost": "YOUR_IP"/,
      },
      {
        name: "custom bind with invalid customBindHost",
        cfg: {
          gateway: {
            bind: "custom" as const,
            customBindHost: "192.168.001.100",
            auth: TOKEN_AUTH,
          },
        },
        expectedMessage: /gateway\.bind=custom requires a valid IPv4 customBindHost[\s\S]*Fix: use a valid IPv4 address like "192\.168\.1\.100"/,
      },
      {
        name: "custom bind with mismatched resolved host",
        cfg: {
          gateway: {
            bind: "custom" as const,
            customBindHost: "192.168.1.100",
            auth: TOKEN_AUTH,
          },
        },
        host: "0.0.0.0",
        expectedMessage: /gateway bind=custom requested 192\.168\.1\.100 but resolved 0\.0\.0\.0[\s\S]*Fix: remove the --host flag/,
      },
    ])("rejects $name", async ({ cfg, host, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789, host })).rejects.toThrow(
        expectedMessage,
      );
    });

    it("rejects non-loopback control UI when allowed origins are missing", async () => {
      await expect(
        resolveGatewayRuntimeConfig({
          cfg: {
            gateway: {
              bind: "lan",
              auth: TOKEN_AUTH,
            },
          },
          port: 18789,
        }),
      ).rejects.toThrow(/non-loopback Control UI requires gateway\.controlUi\.allowedOrigins[\s\S]*Fix: add "allowedOrigins": \["https:\/\/your-domain\.com"\]/);
    });

    it("allows non-loopback control UI without allowed origins when dangerous fallback is enabled", async () => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "lan",
            auth: TOKEN_AUTH,
            controlUi: {
              dangerouslyAllowHostHeaderOriginFallback: true,
            },
          },
        },
        port: 18789,
      });
      expect(result.bindHost).toBe("0.0.0.0");
    });
  });

  describe("HTTP security headers", () => {
    it("resolves strict transport security header from config", async () => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "loopback",
            auth: { mode: "none" },
            http: {
              securityHeaders: {
                strictTransportSecurity: "  max-age=31536000; includeSubDomains  ",
              },
            },
          },
        },
        port: 18789,
      });

      expect(result.strictTransportSecurityHeader).toBe("max-age=31536000; includeSubDomains");
    });

    it("does not set strict transport security when explicitly disabled", async () => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "loopback",
            auth: { mode: "none" },
            http: {
              securityHeaders: {
                strictTransportSecurity: false,
              },
            },
          },
        },
        port: 18789,
      });

      expect(result.strictTransportSecurityHeader).toBeUndefined();
    });
  });
});
