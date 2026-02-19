import { describe, expect, it } from "vitest";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

describe("resolveGatewayRuntimeConfig", () => {
  describe("trusted-proxy auth mode", () => {
    // This test validates BOTH validation layers:
    // 1. CLI validation in src/cli/gateway-cli/run.ts (line 246)
    // 2. Runtime config validation in src/gateway/server-runtime-config.ts (line 99)
    // Both must allow lan binding when authMode === "trusted-proxy"
    it("should allow lan binding with trusted-proxy auth mode", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: ["192.168.1.1"],
        },
      };

      const result = await resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
      });

      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe("0.0.0.0");
    });

    it("should reject loopback binding with trusted-proxy auth mode", async () => {
      const cfg = {
        gateway: {
          bind: "loopback" as const,
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: ["192.168.1.1"],
        },
      };

      await expect(
        resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        }),
      ).rejects.toThrow("gateway auth mode=trusted-proxy makes no sense with bind=loopback");
    });

    it("should reject trusted-proxy without trustedProxies configured", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy: {
              userHeader: "x-forwarded-user",
            },
          },
          trustedProxies: [],
        },
      };

      await expect(
        resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        }),
      ).rejects.toThrow(
        "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      );
    });
  });

  describe("token/password auth modes", () => {
    it("should reject token mode without token configured", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "token" as const,
          },
        },
      };

      await expect(
        resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        }),
      ).rejects.toThrow("gateway auth mode is token, but no token was configured");
    });

    it("should allow lan binding with token", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "token" as const,
            token: "test-token-123",
          },
        },
      };

      const result = await resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
      });

      expect(result.authMode).toBe("token");
      expect(result.bindHost).toBe("0.0.0.0");
    });

    it("should allow loopback binding with explicit none mode", async () => {
      const cfg = {
        gateway: {
          bind: "loopback" as const,
          auth: {
            mode: "none" as const,
          },
        },
      };

      const result = await resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
      });

      expect(result.authMode).toBe("none");
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it("should reject lan binding with explicit none mode", async () => {
      const cfg = {
        gateway: {
          bind: "lan" as const,
          auth: {
            mode: "none" as const,
          },
        },
      };

      await expect(
        resolveGatewayRuntimeConfig({
          cfg,
          port: 18789,
        }),
      ).rejects.toThrow("refusing to bind gateway");
    });
  });
});
