import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeGatewayConnect,
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  resolveGatewayAuth,
} from "./auth.js";

function createLimiterSpy(): AuthRateLimiter & {
  check: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn<AuthRateLimiter["check"]>(
    (_ip, _scope) => ({ allowed: true, remaining: 10, retryAfterMs: 0 }) as const,
  );
  const recordFailure = vi.fn<AuthRateLimiter["recordFailure"]>((_ip, _scope) => {});
  const reset = vi.fn<AuthRateLimiter["reset"]>((_ip, _scope) => {});
  return {
    check,
    recordFailure,
    reset,
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

describe("gateway auth", () => {
  it("resolves token/password from OPENCLAW gateway env vars", () => {
    expect(
      resolveGatewayAuth({
        authConfig: {},
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
          OPENCLAW_GATEWAY_PASSWORD: "env-password",
        } as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "password",
      modeSource: "password",
      token: "env-token",
      password: "env-password",
    });
  });

  it("does not resolve legacy CLAWDBOT gateway env vars", () => {
    expect(
      resolveGatewayAuth({
        authConfig: {},
        env: {
          CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
          CLAWDBOT_GATEWAY_PASSWORD: "legacy-password",
        } as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "token",
      modeSource: "default",
      token: undefined,
      password: undefined,
    });
  });

  it("resolves explicit auth mode none from config", () => {
    expect(
      resolveGatewayAuth({
        authConfig: { mode: "none" },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "none",
      modeSource: "config",
      token: undefined,
      password: undefined,
    });
  });

  it("marks mode source as override when runtime mode override is provided", () => {
    expect(
      resolveGatewayAuth({
        authConfig: { mode: "password", password: "config-password" },
        authOverride: { mode: "token" },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "token",
      modeSource: "override",
      token: undefined,
      password: "config-password",
    });
  });

  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("allows explicit auth mode none", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("keeps none mode authoritative even when token is present", async () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "none", token: "configured-token" },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(auth).toMatchObject({
      mode: "none",
      modeSource: "config",
      token: "configured-token",
    });

    const res = await authorizeGatewayConnect({
      auth,
      connectAuth: null,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("does not allow tailscale identity to satisfy token mode auth by default", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
  });

  it("allows tailscale identity when header auth is explicitly enabled", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      authSurface: "ws-control-ui",
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("keeps tailscale header auth disabled on HTTP auth wrapper", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
  });

  it("enables tailscale header auth on ws control-ui auth wrapper", async () => {
    const res = await authorizeWsControlUiGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("uses proxy-aware request client IP by default for rate-limit checks", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.10" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
  });

  it("ignores X-Real-IP fallback by default for rate-limit checks", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-real-ip": "203.0.113.77" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
  });

  it("uses X-Real-IP when fallback is explicitly enabled", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-real-ip": "203.0.113.77" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      allowRealIpFallback: true,
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
  });

  it("passes custom rate-limit scope to limiter operations", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      rateLimiter: limiter,
      rateLimitScope: "custom-scope",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_mismatch");
    expect(limiter.check).toHaveBeenCalledWith(undefined, "custom-scope");
    expect(limiter.recordFailure).toHaveBeenCalledWith(undefined, "custom-scope");
  });
});

describe("trusted-proxy auth", () => {
  type GatewayConnectInput = Parameters<typeof authorizeGatewayConnect>[0];
  const trustedProxyConfig = {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: [],
  };

  function authorizeTrustedProxy(options?: {
    auth?: GatewayConnectInput["auth"];
    trustedProxies?: string[];
    remoteAddress?: string;
    headers?: Record<string, string>;
  }) {
    return authorizeGatewayConnect({
      auth: options?.auth ?? {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: options?.trustedProxies ?? ["10.0.0.1"],
      req: {
        socket: { remoteAddress: options?.remoteAddress ?? "10.0.0.1" },
        headers: {
          host: "gateway.local",
          ...options?.headers,
        },
      } as never,
    });
  }

  it("accepts valid request from trusted proxy", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects request from untrusted source", async () => {
    const res = await authorizeTrustedProxy({
      remoteAddress: "192.168.1.100",
      headers: {
        "x-forwarded-user": "attacker@evil.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_untrusted_source");
  });

  it("rejects request with missing user header", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_missing");
  });

  it("rejects request with missing required headers", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_missing_header_x-forwarded-proto");
  });

  it("rejects user not in allowlist", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      headers: {
        "x-forwarded-user": "stranger@other.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_not_allowed");
  });

  it("accepts user in allowlist", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects when no trustedProxies configured", async () => {
    const res = await authorizeTrustedProxy({
      trustedProxies: [],
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_no_proxies_configured");
  });

  it("rejects when trustedProxy config missing", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_config_missing");
  });

  it("supports Pomerium-style headers", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-pomerium-claim-email",
          requiredHeaders: ["x-pomerium-jwt-assertion"],
        },
      },
      trustedProxies: ["172.17.0.1"],
      remoteAddress: "172.17.0.1",
      headers: {
        "x-pomerium-claim-email": "nick@example.com",
        "x-pomerium-jwt-assertion": "eyJ...",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("trims whitespace from user header value", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      headers: {
        "x-forwarded-user": "  nick@example.com  ",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.user).toBe("nick@example.com");
  });
});
