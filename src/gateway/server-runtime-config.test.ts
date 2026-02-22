import { describe, expect, it } from "vitest";
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
  describe("gateway HTTP dangerous tool guard", () => {
    it("rejects dangerous HTTP tool re-enables on non-loopback bind without explicit break-glass env", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "token" as const,
            token: "test-token-123",
          },
          tools: {
            allow: ["sessions_spawn"],
          },
        },
      };

      await expect(
        resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        }),
      ).rejects.toThrow(
        "refusing to start gateway with dangerous HTTP /tools/invoke tool re-enables",
      );
    });

    it("allows dangerous HTTP tool re-enables on loopback without break-glass env", async () => {
      const cfg = {
        gateway: {
          auth: {
            mode: "token" as const,
            token: "test-token-123",
          },
          tools: {
            allow: ["sessions_send"],
          },
        },
      };

      const result = await resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
      });

      expect(result.authMode).toBe("token");
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it("allows dangerous HTTP tool re-enables on non-loopback bind with explicit break-glass env", async () => {
      const previous = process.env.OPENCLAW_UNSAFE_ALLOW_GATEWAY_HTTP_DANGEROUS_TOOLS;
      process.env.OPENCLAW_UNSAFE_ALLOW_GATEWAY_HTTP_DANGEROUS_TOOLS = "1";
      try {
        const cfg = {
          gateway: {
            bind: "lan" as const,
            auth: {
              mode: "token" as const,
              token: "test-token-123",
            },
            tools: {
              allow: ["sessions_send"],
            },
          },
        };

        const result = await resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        });

        expect(result.authMode).toBe("token");
        expect(result.bindHost).toBe("0.0.0.0");
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_UNSAFE_ALLOW_GATEWAY_HTTP_DANGEROUS_TOOLS;
        } else {
          process.env.OPENCLAW_UNSAFE_ALLOW_GATEWAY_HTTP_DANGEROUS_TOOLS = previous;
        }
      }
    });
  });

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
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
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
          "gateway auth mode=trusted-proxy with bind=loopback requires gateway.trustedProxies to include 127.0.0.1, ::1, or a loopback CIDR",
      },
      {
        name: "lan binding without trusted proxies",
        cfg: {
          gateway: { bind: "lan" as const, auth: TRUSTED_PROXY_AUTH, trustedProxies: [] },
        },
        expectedMessage:
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      },
    ])("rejects $name", async ({ cfg, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789 })).rejects.toThrow(
        expectedMessage,
      );
    });
  });

  describe("token/password auth modes", () => {
    it.each([
      {
        name: "lan binding with token",
        cfg: { gateway: { bind: "lan" as const, auth: TOKEN_AUTH } },
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
        expectedMessage: "gateway auth mode is token, but no token was configured",
      },
      {
        name: "lan binding with explicit none auth",
        cfg: { gateway: { bind: "lan" as const, auth: { mode: "none" as const } } },
        expectedMessage: "refusing to bind gateway",
      },
      {
        name: "loopback binding that resolves to non-loopback host",
        cfg: { gateway: { bind: "loopback" as const, auth: { mode: "none" as const } } },
        host: "0.0.0.0",
        expectedMessage: "gateway bind=loopback resolved to non-loopback host",
      },
      {
        name: "custom bind without customBindHost",
        cfg: { gateway: { bind: "custom" as const, auth: TOKEN_AUTH } },
        expectedMessage: "gateway.bind=custom requires gateway.customBindHost",
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
        expectedMessage: "gateway.bind=custom requires a valid IPv4 customBindHost",
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
        expectedMessage: "gateway bind=custom requested 192.168.1.100 but resolved 0.0.0.0",
      },
    ])("rejects $name", async ({ cfg, host, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789, host })).rejects.toThrow(
        expectedMessage,
      );
    });
  });
});
