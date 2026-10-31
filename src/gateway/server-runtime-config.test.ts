import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as containerEnvironment from "../infra/container-environment.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const hooksWarn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "gateway/hooks" ? { ...logger, warn: hooksWarn } : logger;
    },
  };
});

const TRUSTED_PROXY_AUTH = {
  mode: "trusted-proxy" as const,
  trustedProxy: { userHeader: "x-forwarded-user" },
};

const TOKEN_AUTH = { mode: "token" as const, token: "test-token-123" };

function gateway(config: OpenClawConfig["gateway"]): OpenClawConfig {
  return { gateway: config };
}

function resolve(cfg: OpenClawConfig, host?: string) {
  return resolveGatewayRuntimeConfig({ cfg, port: 18789, host });
}

const allowedOrigins = ["https://control.example.com"];
const trustedProxyGateway = {
  bind: "lan" as const,
  auth: TRUSTED_PROXY_AUTH,
  controlUi: { allowedOrigins },
};

describe("resolveGatewayRuntimeConfig", () => {
  describe("unresolved external hook credentials", () => {
    it.each(["missing", "pending"] as const)(
      "disables hooks and warns without blocking startup for %s credentials",
      async (kind) => {
        hooksWarn.mockClear();
        const cfg: OpenClawConfig = {
          gateway: { bind: "loopback", auth: TOKEN_AUTH },
          hooks: { enabled: true, token: "synthetic-unresolved-hook-value" },
        };
        setConfigResolutionFacts(
          cfg,
          createConfigResolutionFacts(
            kind === "missing"
              ? [{ varName: "MISSING_HOOK_SECRET", configPath: "hooks.token" }]
              : [],
            kind === "pending" ? new Map([["hooks.token", "PENDING_HOOK_SECRET"]]) : new Map(),
          ),
        );
        const result = await resolve(cfg);
        expect(result.hooksConfig).toBeNull();
        expect(result.bindHost).toBe("127.0.0.1");
        expect(result.resolvedAuth.token).toBe(TOKEN_AUTH.token);
        expect(hooksWarn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("External hooks disabled at startup:"),
        );
        expect(hooksWarn.mock.calls[0]?.[0]).not.toContain("synthetic-unresolved-hook-value");
      },
    );

    it("does not suppress unrelated invalid hook settings", async () => {
      await expect(
        resolve({
          gateway: { bind: "loopback", auth: TOKEN_AUTH },
          hooks: { enabled: true, token: "synthetic-valid-hook-secret", path: "/" },
        }),
      ).rejects.toThrow("hooks.path may not be");
    });
  });
  describe("trusted-proxy auth mode", () => {
    it("allows lan binding", async () => {
      const result = await resolve(
        gateway({ ...trustedProxyGateway, trustedProxies: ["192.168.1.1"] }),
      );
      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe("0.0.0.0");
    });

    it("rejects lan binding without trusted proxies", async () => {
      await expect(
        resolve(gateway({ ...trustedProxyGateway, trustedProxies: [] })),
      ).rejects.toThrow(
        "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      );
    });

    it("allows loopback binding with non-loopback trusted proxies", async () => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "loopback",
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["10.0.0.1"],
          },
        },
        port: 18789,
      });

      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe("127.0.0.1");
    });
  });

  describe("token/password auth modes", () => {
    beforeEach(() => vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined));

    afterEach(() => vi.unstubAllEnvs());

    it("allows loopback binding with explicit none auth", async () => {
      const result = await resolve(gateway({ bind: "loopback", auth: { mode: "none" } }));
      expect(result.authMode).toBe("none");
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it.each([
      {
        name: "token mode without token",
        cfg: gateway({ bind: "lan", auth: { mode: "token" } }),
        expectedMessage:
          "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
      },
      {
        name: "lan binding with explicit none auth",
        cfg: gateway({ bind: "lan", auth: { mode: "none" } }),
        expectedMessage: "refusing to bind gateway",
      },
      {
        name: "loopback binding that resolves to non-loopback host",
        cfg: gateway({ bind: "loopback", auth: { mode: "none" } }),
        host: "0.0.0.0",
        expectedMessage: "gateway bind=loopback resolved to non-loopback host",
      },
      {
        name: "tailnet binding that falls through to wildcard",
        cfg: gateway({ bind: "tailnet", auth: TOKEN_AUTH }),
        host: "0.0.0.0",
        expectedMessage: "gateway bind=tailnet could not resolve a Tailscale or loopback address",
      },
      {
        name: "custom bind without customBindHost",
        cfg: gateway({ bind: "custom", auth: TOKEN_AUTH }),
        expectedMessage: "gateway.bind=custom requires gateway.customBindHost",
      },
      {
        name: "custom bind with invalid customBindHost",
        cfg: gateway({ bind: "custom", customBindHost: "192.168.001.100", auth: TOKEN_AUTH }),
        expectedMessage: "gateway.bind=custom requires a valid IPv4 customBindHost",
      },
      {
        name: "custom bind with mismatched resolved host",
        cfg: gateway({ bind: "custom", customBindHost: "192.168.1.100", auth: TOKEN_AUTH }),
        host: "0.0.0.0",
        expectedMessage: "gateway bind=custom requested 192.168.1.100 but resolved 0.0.0.0",
      },
    ])("rejects $name", async ({ cfg, host, expectedMessage }) => {
      await expect(resolve(cfg, host)).rejects.toThrow(expectedMessage);
    });

    it.each([
      {
        name: "rejects non-loopback control UI when allowed origins are missing",
        cfg: gateway({ bind: "lan", auth: TOKEN_AUTH }),
        expectedError: "non-loopback Control UI requires gateway.controlUi.allowedOrigins",
      },
      {
        name: "allows non-loopback control UI with the advertised public origin",
        cfg: gateway({ bind: "lan", auth: TOKEN_AUTH, publicOrigin: allowedOrigins[0] }),
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "does not replace an explicit empty origin list with the public origin",
        cfg: gateway({
          bind: "lan",
          auth: TOKEN_AUTH,
          publicOrigin: allowedOrigins[0],
          controlUi: { allowedOrigins: [] },
        }),
        expectedError: "non-loopback Control UI requires gateway.controlUi.allowedOrigins",
      },
      {
        name: "allows non-loopback control UI without allowed origins when dangerous fallback is enabled",
        cfg: gateway({
          bind: "lan",
          auth: TOKEN_AUTH,
          controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
        }),
        expectedBindHost: "0.0.0.0",
      },
    ])("$name", async ({ cfg, expectedError, expectedBindHost }) => {
      if (expectedError) {
        await expect(resolve(cfg)).rejects.toThrow(expectedError);
        return;
      }
      const result = await resolve(cfg);
      expect(result.bindHost).toBe(expectedBindHost);
    });
  });

  describe("container-aware bind default", () => {
    beforeEach(() =>
      vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(true),
    );
    afterEach(() => vi.restoreAllMocks());

    const authenticated = { auth: TOKEN_AUTH, controlUi: { allowedOrigins } };
    it.each<[string, NonNullable<OpenClawConfig["gateway"]>, string]>([
      ["auto", authenticated, "0.0.0.0"],
      ["explicit loopback", { bind: "loopback", auth: { mode: "none" } }, "127.0.0.1"],
      ["implicit serve loopback", { auth: TOKEN_AUTH, tailscale: { mode: "serve" } }, "127.0.0.1"],
      [
        "implicit funnel loopback",
        {
          auth: { mode: "password", password: "test-pw" },
          tailscale: { mode: "funnel" },
        },
        "127.0.0.1",
      ],
      ["explicit lan", { ...authenticated, bind: "lan" }, "0.0.0.0"],
    ])("resolves %s inside a container", async (_name, config, bindHost) => {
      expect((await resolve(gateway(config))).bindHost).toBe(bindHost);
    });

    it.each<[string, NonNullable<OpenClawConfig["gateway"]>, string]>([
      [
        "auto-bind without origins",
        { auth: TOKEN_AUTH },
        "non-loopback Control UI requires gateway.controlUi.allowedOrigins",
      ],
      ["auto-bind without auth", { auth: { mode: "none" } }, "refusing to bind gateway"],
      [
        "serve without auth",
        { auth: { mode: "none" }, tailscale: { mode: "serve" } },
        "gateway.auth.mode=none cannot be used with gateway.tailscale.mode=serve",
      ],
    ])("rejects %s inside a container", async (_name, config, error) => {
      await expect(resolve(gateway(config))).rejects.toThrow(error);
    });
  });
});
