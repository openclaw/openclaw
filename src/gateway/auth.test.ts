import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  assertGatewayAuthConfigured,
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

function createTailscaleForwardedReq(): never {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "gateway.local",
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "ai-hub.bone-egret.ts.net",
      "tailscale-user-login": "peter",
      "tailscale-user-name": "Peter",
    },
  } as never;
}

function createTailscaleWhois() {
  return async () => ({ login: "peter", name: "Peter" });
}

describe("gateway auth", () => {
  async function expectTokenMismatchWithLimiter(params: {
    reqHeaders: Record<string, string>;
    allowRealIpFallback?: boolean;
  }) {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: params.reqHeaders,
      } as never,
      trustedProxies: ["127.0.0.1"],
      ...(params.allowRealIpFallback ? { allowRealIpFallback: true } : {}),
      rateLimiter: limiter,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    return limiter;
  }

  async function expectTailscaleHeaderAuthResult(params: {
    authorize: typeof authorizeHttpGatewayConnect | typeof authorizeWsControlUiGatewayConnect;
    expected: { ok: false; reason: string } | { ok: true; method: string; user: string };
  }) {
    const res = await params.authorize({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req: createTailscaleForwardedReq(),
    });
    expect(res.ok).toBe(params.expected.ok);
    if (!params.expected.ok) {
      expect(res.reason).toBe(params.expected.reason);
      return;
    }
    expect(res.method).toBe(params.expected.method);
    expect(res.user).toBe(params.expected.user);
  }

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

  it("keeps gateway auth config values ahead of env overrides", () => {
    expect(
      resolveGatewayAuth({
        authConfig: {
          token: "config-token",
          password: "config-password", // pragma: allowlist secret
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
          OPENCLAW_GATEWAY_PASSWORD: "env-password",
        } as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      token: "config-token",
      password: "config-password", // pragma: allowlist secret
    });
  });

  it("treats env-template auth secrets as SecretRefs instead of plaintext", () => {
    expect(
      resolveGatewayAuth({
        authConfig: {
          token: "${OPENCLAW_GATEWAY_TOKEN}",
          password: "${OPENCLAW_GATEWAY_PASSWORD}",
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
          OPENCLAW_GATEWAY_PASSWORD: "env-password",
        } as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      token: "env-token",
      password: "env-password",
      mode: "password",
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
        authConfig: { mode: "password", password: "config-password" }, // pragma: allowlist secret
        authOverride: { mode: "token" },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      mode: "token",
      modeSource: "override",
      token: undefined,
      password: "config-password", // pragma: allowlist secret
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
      tailscaleWhois: createTailscaleWhois(),
      req: createTailscaleForwardedReq(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
  });

  it("allows tailscale identity when header auth is explicitly enabled", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      authSurface: "ws-control-ui",
      req: createTailscaleForwardedReq(),
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("keeps tailscale header auth disabled on HTTP auth wrapper", async () => {
    await expectTailscaleHeaderAuthResult({
      authorize: authorizeHttpGatewayConnect,
      expected: { ok: false, reason: "token_missing" },
    });
  });

  it("enables tailscale header auth on ws control-ui auth wrapper", async () => {
    await expectTailscaleHeaderAuthResult({
      authorize: authorizeWsControlUiGatewayConnect,
      expected: { ok: true, method: "tailscale", user: "peter" },
    });
  });

  it("uses proxy-aware request client IP by default for rate-limit checks", async () => {
    const limiter = await expectTokenMismatchWithLimiter({
      reqHeaders: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
  });

  it("ignores X-Real-IP fallback by default for rate-limit checks", async () => {
    const limiter = await expectTokenMismatchWithLimiter({
      reqHeaders: { "x-real-ip": "203.0.113.77" },
    });
    expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
  });

  it("uses X-Real-IP when fallback is explicitly enabled", async () => {
    const limiter = await expectTokenMismatchWithLimiter({
      reqHeaders: { "x-real-ip": "203.0.113.77" },
      allowRealIpFallback: true,
    });
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
  it("does not record rate-limit failure for missing token (misconfigured client, not brute-force)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("does not record rate-limit failure for missing password (misconfigured client, not brute-force)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("still records rate-limit failure for wrong token (brute-force attempt)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.recordFailure).toHaveBeenCalled();
  });

  it("still records rate-limit failure for wrong password (brute-force attempt)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_mismatch");
    expect(limiter.recordFailure).toHaveBeenCalled();
  });
  it("throws specific error when password is a provider reference object", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "password",
        password: { source: "exec", provider: "op", id: "pw" } as never,
      },
    });
    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "password",
        password: { source: "exec", provider: "op", id: "pw" } as never,
      }),
    ).toThrow(/provider reference object/);
  });

  it("accepts password mode when env provides OPENCLAW_GATEWAY_PASSWORD", () => {
    const rawPasswordRef = { source: "exec", provider: "op", id: "pw" } as never;
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "password",
        password: rawPasswordRef,
      },
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.password).toBe("env-password");
    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "password",
        password: rawPasswordRef,
      }),
    ).not.toThrow();
  });

  it("throws generic error when password mode has no password at all", () => {
    const auth = resolveGatewayAuth({ authConfig: { mode: "password" } });
    expect(() => assertGatewayAuthConfigured(auth, { mode: "password" })).toThrow(
      "gateway auth mode is password, but no password was configured",
    );
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

  it("rejects trusted-proxy HTTP requests from origins outside the allowlist", async () => {
    await expect(
      authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["10.0.0.1"],
        req: {
          socket: { remoteAddress: "10.0.0.1" },
          headers: {
            host: "gateway.example.com",
            origin: "https://evil.example",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin: "https://evil.example",
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_origin_not_allowed",
    });
  });

  it("accepts trusted-proxy HTTP requests from allowed origins", async () => {
    await expect(
      authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["10.0.0.1"],
        req: {
          socket: { remoteAddress: "10.0.0.1" },
          headers: {
            host: "gateway.example.com",
            origin: "https://control.example.com",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin: "https://control.example.com",
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      method: "trusted-proxy",
      user: "nick@example.com",
    });
  });

  it("keeps origin-less trusted-proxy HTTP requests working", async () => {
    await expect(
      authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["10.0.0.1"],
        req: {
          socket: { remoteAddress: "10.0.0.1" },
          headers: {
            host: "gateway.example.com",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      method: "trusted-proxy",
      user: "nick@example.com",
    });
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

  it("rejects request when trusted-proxy authenticity header is missing", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          authHeader: "x-gateway-proxy-auth",
          authValue: "proxy-secret",
        },
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_auth_header_mismatch");
  });

  it("rejects request when trusted-proxy authenticity header is wrong", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          authHeader: "x-gateway-proxy-auth",
          authValue: "proxy-secret",
        },
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
        "x-gateway-proxy-auth": "wrong-secret",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_auth_header_mismatch");
  });

  it("accepts request when trusted-proxy authenticity header matches", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          authHeader: "x-gateway-proxy-auth",
          authValue: "proxy-secret",
        },
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
        "x-gateway-proxy-auth": "proxy-secret",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
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

  it.each([
    {
      name: "config token",
      authConfig: {
        mode: "trusted-proxy" as const,
        token: "shared-secret",
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      env: undefined,
    },
    {
      name: "environment token",
      authConfig: {
        mode: "trusted-proxy" as const,
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "shared-secret",
      } as NodeJS.ProcessEnv,
    },
  ])("rejects trusted-proxy mode when shared token comes from $name", ({ authConfig, env }) => {
    const auth = resolveGatewayAuth({
      authConfig,
      env,
    });

    expect(auth.mode).toBe("trusted-proxy");
    expect(auth.token).toBe("shared-secret");

    expect(() => assertGatewayAuthConfigured(auth, authConfig)).toThrow(/mutually exclusive/);
  });

  it("still requires trustedProxy config before reporting a token conflict", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        token: "shared-secret",
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        token: "shared-secret",
      }),
    ).toThrow(/no trustedProxy config was provided/);
  });

  it("rejects trusted-proxy mode when only authHeader is configured", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "x-gateway-proxy-auth",
        },
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "x-gateway-proxy-auth",
        },
      }),
    ).toThrow(/must be set together/);
  });

  it("rejects trusted-proxy mode when only authValue is configured", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authValue: "proxy-secret",
        },
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authValue: "proxy-secret",
        },
      }),
    ).toThrow(/must be set together/);
  });

  it("rejects trusted-proxy mode when authHeader is whitespace only", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "   ",
          authValue: "proxy-secret",
        },
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "   ",
          authValue: "proxy-secret",
        },
      }),
    ).toThrow(/must be non-empty when configured/);
  });

  it("rejects trusted-proxy mode when authValue is whitespace only", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "x-gateway-proxy-auth",
          authValue: "   ",
        },
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          authHeader: "x-gateway-proxy-auth",
          authValue: "   ",
        },
      }),
    ).toThrow(/must be non-empty when configured/);
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

  describe("local-direct trusted-proxy requests", () => {
    function authorizeLocalDirect(options?: {
      token?: string;
      connectToken?: string;
      trustedProxy?: GatewayConnectInput["auth"]["trustedProxy"];
      trustedProxies?: string[];
    }) {
      return authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          ...(Object.hasOwn(options ?? {}, "trustedProxy")
            ? { trustedProxy: options?.trustedProxy }
            : { trustedProxy: trustedProxyConfig }),
          token: options?.token,
        },
        connectAuth: options?.connectToken ? { token: options.connectToken } : null,
        trustedProxies: options?.trustedProxies ?? ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: { host: "localhost" },
        } as never,
      });
    }

    it.each([
      {
        name: "without credentials",
        options: {
          token: "secret",
        },
      },
      {
        name: "with a valid token",
        options: {
          token: "secret",
          connectToken: "secret",
        },
      },
      {
        name: "with a wrong token",
        options: {
          token: "secret",
          connectToken: "wrong",
        },
      },
      {
        name: "when no local token is configured",
        options: {
          connectToken: "secret",
        },
      },
    ])("rejects local-direct request $name", async ({ options }) => {
      const res = await authorizeLocalDirect(options);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects trusted-proxy identity headers from loopback sources", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy when proxy authenticity header is missing", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "203.0.113.10",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("fails closed when forwarded headers are present but the client chain resolves to loopback", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
          token: "secret",
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-proto": "https",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects direct loopback even when Host is not localish", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
          token: "secret",
        },
        connectAuth: { token: "secret" },
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "evil.example",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects same-host proxy request with missing required header", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            // missing x-forwarded-proto (requiredHeader)
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("still fails closed when trusted-proxy config is missing", async () => {
      const res = await authorizeLocalDirect({
        token: "secret",
        connectToken: "secret",
        trustedProxy: undefined,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_config_missing");
    });

    it("still fails closed when trusted proxies are not configured", async () => {
      const res = await authorizeLocalDirect({
        token: "secret",
        connectToken: "secret",
        trustedProxies: [],
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_no_proxies_configured");
    });

    it("rejects loopback proxy when x-forwarded-for is missing", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            // x-forwarded-for is missing — direct localhost process spoofing headers
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy when x-forwarded-for is empty", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "  ",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy when x-forwarded-for chain is empty", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "  ,  , ",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy when x-forwarded-for resolves to loopback", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "127.0.0.1",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy when x-forwarded-for is not an IP chain", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "totally-not-an-ip",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects loopback proxy without matching proxy auth header", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            ...trustedProxyConfig,
            authHeader: "x-gateway-proxy-auth",
            authValue: "proxy-secret",
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "203.0.113.10",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_auth_header_mismatch");
    });

    it("accepts loopback proxy when forwarded client IP is non-loopback and proxy auth header matches", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            ...trustedProxyConfig,
            authHeader: "x-gateway-proxy-auth",
            authValue: "proxy-secret",
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "203.0.113.10",
            "x-gateway-proxy-auth": "proxy-secret",
          },
        } as never,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) {
        return;
      }
      expect(res.method).toBe("trusted-proxy");
      expect(res.user).toBe("nick@example.com");
    });

    it("accepts loopback proxy when x-forwarded-for contains valid client IPs and proxy auth header matches", async () => {
      const res = await authorizeGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            ...trustedProxyConfig,
            authHeader: "x-gateway-proxy-auth",
            authValue: "proxy-secret",
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
            "x-forwarded-for": "203.0.113.10, 10.0.0.1",
            "x-gateway-proxy-auth": "proxy-secret",
          },
        } as never,
      });
      expect(res.ok).toBe(true);
      expect(res.method).toBe("trusted-proxy");
      expect(res.user).toBe("nick@example.com");
    });
  });
});
