import type { IncomingMessage } from "node:http";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { createLimiterSpy } from "./auth-rate-limit.test-support.js";
import {
  assertGatewayAuthConfigured,
  authorizeHttpGatewayConnect,
  authorizeControlUiReadHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  resolveGatewayAuth,
} from "./auth.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { hasForwardedRequestHeaders, isLocalDirectRequest } from "./net.js";

function createSingleAttemptLimiter() {
  return createGatewayAuthRateLimiter(
    {
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    },
    { scheduler: createTestGatewayScheduler() },
  );
}

type TailscaleForwardedRequest = IncomingMessage & {
  socket: IncomingMessage["socket"] & { remoteAddress?: string };
  headers: IncomingMessage["headers"] & Record<string, string | undefined>;
};

type GatewayConnectInput = Parameters<typeof authorizeHttpGatewayConnect>[0];

function request(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
  return {
    socket: { remoteAddress, localPort: 18_789 },
    headers,
  } as unknown as TailscaleForwardedRequest;
}

function createTailscaleForwardedReq(managed = true): TailscaleForwardedRequest {
  const req = request({
    host: "gateway.local",
    "x-forwarded-for": "100.64.0.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "ai-hub.bone-egret.ts.net",
    "tailscale-user-login": "peter@github",
    "tailscale-user-name": "Peter",
    "tailscale-user-profile-pic": "https://avatars.example.test/peter.png",
    "sec-fetch-site": "same-origin",
  });
  if (managed) {
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  }
  return req;
}

const lookupTailscaleIdentity = async () => ({ login: "peter@github", name: "Peter" });

function authorizeServe(options: Partial<GatewayConnectInput> = {}) {
  return authorizeWsControlUiGatewayConnect({
    auth: { mode: "token", token: "secret", allowTailscale: true },
    connectAuth: null,
    req: createTailscaleForwardedReq(),
    tailscaleWhois: lookupTailscaleIdentity,
    ...options,
  });
}

function authorizeAvatar(
  req: TailscaleForwardedRequest,
  options: Partial<GatewayConnectInput> = {},
  allowedOrigins: string[] = [],
) {
  return authorizeControlUiReadHttpGatewayConnect({
    auth: { mode: "token", token: "secret", allowTailscale: true },
    connectAuth: null,
    tailscaleWhois: lookupTailscaleIdentity,
    req,
    browserOriginPolicy: {
      requestHost: req.headers.host,
      origin: req.headers.origin,
      fetchSite: req.headers["sec-fetch-site"],
      allowedOrigins,
    },
    ...options,
  });
}

it.each(["null", "  undefined  ", "  "])(
  "rejects placeholder token %j at startup and the request boundary",
  async (token) => {
    const auth = { mode: "token" as const, token, allowTailscale: false };
    expect(() => assertGatewayAuthConfigured(auth)).toThrow(
      /must not be blank|no token was configured/,
    );
    await expect(
      authorizeHttpGatewayConnect({ auth, connectAuth: { token } }),
    ).resolves.toMatchObject({ ok: false });
  },
);

describe("HTTP shared-secret fields", () => {
  const authorize = authorizeHttpGatewayConnect;
  const secrets = { token: "token-secret", password: "password-secret", allowTailscale: false };
  it.each(["token", "password"] as const)(
    "%s mode accepts either field but only its configured secret",
    async (mode) => {
      const auth = { mode, ...secrets };
      const otherField = mode === "token" ? "password" : "token";
      const limiter = createLimiterSpy();
      for (const field of [mode, otherField]) {
        await expect(
          authorize({ auth, connectAuth: { [field]: auth[mode] }, rateLimiter: limiter }),
        ).resolves.toEqual({ ok: true, method: mode });
        await expect(
          authorize({ auth, connectAuth: { [field]: auth[otherField] }, rateLimiter: limiter }),
        ).resolves.toEqual({ ok: false, reason: `${mode}_mismatch` });
      }
      expect(limiter.reset).toHaveBeenCalledTimes(2);
      expect(limiter.recordFailure).toHaveBeenCalledTimes(2);
      await expect(authorize({ auth, connectAuth: {}, rateLimiter: limiter })).resolves.toEqual({
        ok: false,
        reason: `${mode}_missing`,
      });
      expect(limiter.recordFailure).toHaveBeenCalledTimes(2);
    },
  );

  it("gives the matching field precedence and preserves deferred failures", async () => {
    const auth = { mode: "token" as const, ...secrets };
    const limiter = createLimiterSpy();
    await expect(
      authorize({
        auth,
        connectAuth: { token: "wrong", password: "token-secret" },
        rateLimiter: limiter,
        deferRateLimitFailure: true,
      }),
    ).resolves.toEqual({ ok: false, reason: "token_mismatch" });
    expect(limiter.recordFailure).not.toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();
    await expect(
      authorize({ auth, connectAuth: { token: "token-secret", password: "wrong" } }),
    ).resolves.toEqual({ ok: true, method: "token" });
  });
});

describe("gateway auth", () => {
  it.each([
    { name: "Forwarded", headers: { forwarded: "" } },
    { name: "X-Forwarded-User", headers: { "x-forwarded-user": "nick@example.com" } },
    { name: "X-Real-IP", headers: { "x-real-ip": "" } },
  ])("treats $name as forwarded request evidence", ({ headers }) => {
    const req = request(headers);

    expect(hasForwardedRequestHeaders(req)).toBe(true);
    expect(isLocalDirectRequest(req)).toBe(false);
  });

  it("treats env-template auth secrets as SecretRefs instead of plaintext", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        token: "${OPENCLAW_GATEWAY_TOKEN}",
        password: "${OPENCLAW_GATEWAY_PASSWORD}",
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.token).toBe("env-token");
    expect(auth.password).toBe("env-password");
    expect(auth.mode).toBe("password");
    expect(auth.modeSource).toBe("password");
    expect(assertGatewayAuthConfigured(auth)).toBeUndefined();
  });

  it("marks mode source as override when runtime mode override is provided", () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "password", password: "config-password" }, // pragma: allowlist secret
      authOverride: { mode: "token" },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(auth.mode).toBe("token");
    expect(auth.modeSource).toBe("override");
    expect(auth.token).toBeUndefined();
    expect(auth.password).toBe("config-password"); // pragma: allowlist secret
  });

  it("authorizes matching token auth when req is missing socket", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      req: {} as never,
      browserOriginPolicy: { origin: "https://app.example", allowedOrigins: [] },
    });
    expect(res.ok).toBe(true);
  });

  it.each([
    {
      host: "gateway.example.com",
      origin: "https://evil.example",
      remote: "10.0.0.1",
      expected: { ok: false, reason: "origin_not_allowed" },
    },
    {
      host: "127.0.0.1",
      origin: "http://localhost:5173",
      remote: "127.0.0.1",
      expected: { ok: true, method: "none" },
    },
  ])("checks $origin under none-mode HTTP auth", async ({ host, origin, remote, expected }) => {
    const result = await authorizeHttpGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
      req: request({ host, origin }, remote),
      browserOriginPolicy: { requestHost: host, origin },
    });
    expect(result).toEqual(expected);
  });

  it("keeps none mode authoritative even when token is present", async () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "none", token: "configured-token" },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(auth.mode).toBe("none");
    expect(auth.modeSource).toBe("config");
    expect(auth.token).toBe("configured-token");

    await expect(authorizeHttpGatewayConnect({ auth, connectAuth: null })).resolves.toMatchObject({
      ok: true,
      method: "none",
    });
  });

  it("reports missing password config even when a token is configured", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "password", token: "secret", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res).toMatchObject({ ok: false, reason: "password_missing_config" });
  });

  it("does not allow tailscale identity to satisfy token mode auth by default", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: lookupTailscaleIdentity,
      req: createTailscaleForwardedReq(),
    });

    expect(res).toMatchObject({ ok: false, reason: "token_missing" });
  });

  it("rejects matching Tailscale-shaped identity without managed Serve provenance", async () => {
    const req = createTailscaleForwardedReq(false);
    const limiter = createLimiterSpy();

    const res = await authorizeServe({
      req,
      connectAuth: { token: "secret" },
      rateLimiter: limiter,
    });

    expect(res).toEqual({ ok: false, reason: "proxy_attribution_required" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(limiter.recordFailure).not.toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();
  });

  it("keeps externally managed Tailscale ingress on ordinary trusted-proxy auth semantics", async () => {
    const tailscaleWhois = vi.fn(lookupTailscaleIdentity);
    const authorize = (connectAuth: { token: string } | null) =>
      authorizeServe({
        connectAuth,
        tailscaleWhois,
        req: createTailscaleForwardedReq(false),
        trustedProxies: ["127.0.0.1"],
      });

    await expect(authorize({ token: "secret" })).resolves.toMatchObject({
      ok: true,
      method: "token",
    });
    await expect(authorize(null)).resolves.toEqual({ ok: false, reason: "token_missing" });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("keeps managed Serve failures isolated to each validated source", async () => {
    const limiter = createSingleAttemptLimiter();
    const tailscaleWhois = vi.fn(async () => null);
    const first = createTailscaleForwardedReq();
    const second = createTailscaleForwardedReq();
    second.headers["x-forwarded-for"] = "100.64.0.2";
    const authorize = (req: IncomingMessage, token: string) =>
      authorizeServe({ req, connectAuth: { token }, rateLimiter: limiter, tailscaleWhois });

    try {
      await expect(authorize(first, "wrong")).resolves.toMatchObject({
        ok: false,
        reason: "token_mismatch",
      });
      await expect(authorize(second, "secret")).resolves.toMatchObject({
        ok: true,
        method: "token",
      });
      await expect(authorize(first, "secret")).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
      expect(tailscaleWhois).not.toHaveBeenCalled();
    } finally {
      limiter.dispose();
    }
  });

  it("verifies managed Serve identity before a same-source shared-secret lockout", async () => {
    const limiter = createSingleAttemptLimiter();

    try {
      await expect(
        authorizeServe({
          connectAuth: { token: "wrong" },
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(limiter.check("100.64.0.1", "shared-secret").allowed).toBe(false);

      await expect(authorizeServe({ rateLimiter: limiter })).resolves.toEqual({
        ok: true,
        method: "tailscale",
        user: "peter@github",
        tailscaleIdentity: {
          login: "peter@github",
          name: "Peter",
          profilePic: "https://avatars.example.test/peter.png",
        },
      });
      expect(limiter.check("100.64.0.1", "shared-secret").allowed).toBe(true);
    } finally {
      limiter.dispose();
    }
  });

  it("serializes managed Serve auth through the delayed failure write", async () => {
    let locked = false;
    const { promise: failureStarted, resolve: markFailureStarted } = Promise.withResolvers<void>();
    const { promise: failureGate, resolve: releaseFailure } = Promise.withResolvers<void>();
    const recordFailureAndDelay = vi.fn(async () => {
      markFailureStarted();
      await failureGate;
      locked = true;
    });
    const reset = vi.fn(() => {
      locked = false;
    });
    const limiter: AuthRateLimiter = {
      check: vi.fn(() => ({
        allowed: !locked,
        remaining: locked ? 0 : 1,
        retryAfterMs: locked ? 60_000 : 0,
      })),
      recordFailure: vi.fn(() => {
        locked = true;
      }),
      recordFailureAndDelay,
      reset,
      size: () => Number(locked),
      prune: () => {},
      dispose: () => {},
    };
    const authorize = (token: string) =>
      authorizeServe({ connectAuth: { token }, rateLimiter: limiter });

    const first = authorize("wrong");
    await failureStarted;
    const second = authorize("secret");
    releaseFailure();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: false, reason: "token_mismatch" },
      { ok: false, reason: "rate_limited" },
    ]);
    expect(recordFailureAndDelay).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });

  it("uses password auth for managed Funnel", async () => {
    const req = createTailscaleForwardedReq(false);
    req.headers["tailscale-funnel-request"] = "?1";
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });

    await expect(
      authorizeWsControlUiGatewayConnect({
        auth: { mode: "password", password: "secret", allowTailscale: false },
        connectAuth: { password: "secret" },
        req,
      }),
    ).resolves.toMatchObject({ ok: true, method: "password" });
  });

  it("requires the Funnel password when Tailscale header auth is explicitly enabled", async () => {
    const req = createTailscaleForwardedReq(false);
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });

    await expect(
      authorizeWsControlUiGatewayConnect({
        auth: { mode: "password", password: "secret", allowTailscale: true },
        connectAuth: null,
        tailscaleWhois: lookupTailscaleIdentity,
        req,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "password_missing" });
  });

  it("allows an origin-less same-origin image through the Control UI read surface", async () => {
    const limiter = createLimiterSpy();
    await expect(
      authorizeAvatar(createTailscaleForwardedReq(), { rateLimiter: limiter }),
    ).resolves.toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(limiter.reset).toHaveBeenCalledWith("100.64.0.1", "shared-secret");
  });

  it("rejects wildcard origin grants for ambient Tailscale avatar identity", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://evil.example";
    req.headers["sec-fetch-site"] = "cross-site";
    const tailscaleWhois = vi.fn(lookupTailscaleIdentity);
    await expect(authorizeAvatar(req, { tailscaleWhois }, ["*"])).resolves.toMatchObject({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("allows an approved Control UI origin before verifying Tailscale avatar identity", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://control.example.com";
    req.headers["sec-fetch-site"] = "cross-site";
    const tailscaleWhois = vi.fn(lookupTailscaleIdentity);
    await expect(
      authorizeAvatar(req, { tailscaleWhois }, ["https://control.example.com"]),
    ).resolves.toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
    expect(tailscaleWhois).toHaveBeenCalledOnce();
  });

  it("rejects an origin-less avatar request without same-origin fetch metadata", async () => {
    const req = createTailscaleForwardedReq();
    delete req.headers["sec-fetch-site"];
    const tailscaleWhois = vi.fn(lookupTailscaleIdentity);
    await expect(authorizeAvatar(req, { tailscaleWhois })).resolves.toMatchObject({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing identity",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        delete req.headers["tailscale-user-login"];
      },
      whois: lookupTailscaleIdentity,
      expectedReason: "token_missing",
    },
    {
      name: "mismatched identity",
      mutate: () => {},
      whois: async () => ({ login: "mallory", name: "Mallory" }),
      expectedReason: "token_missing",
    },
    {
      name: "non-loopback source",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        req.socket.remoteAddress = "192.0.2.10";
      },
      whois: lookupTailscaleIdentity,
      expectedReason: "proxy_attribution_required",
    },
    {
      name: "incomplete forwarded headers",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        delete req.headers["x-forwarded-host"];
      },
      whois: lookupTailscaleIdentity,
      expectedReason: "proxy_attribution_required",
    },
  ])(
    "rejects $name on the Control UI read HTTP surface",
    async ({ mutate, whois, expectedReason }) => {
      const req = createTailscaleForwardedReq();
      mutate(req);

      const res = await authorizeAvatar(req, { tailscaleWhois: whois });

      expect(res).toMatchObject({ ok: false, reason: expectedReason });
    },
  );

  it("keeps explicit password auth on the Control UI read HTTP surface", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://evil.example";
    req.headers["sec-fetch-site"] = "cross-site";
    await expect(
      authorizeAvatar(
        req,
        {
          auth: { mode: "password", password: "secret", allowTailscale: true },
          connectAuth: { password: "secret" },
        },
        ["*"],
      ),
    ).resolves.toMatchObject({ ok: true, method: "password" });
  });

  it("keeps trusted-proxy client lockout and reset state isolated by source", async () => {
    const limiter = createSingleAttemptLimiter();
    const authorize = async (clientIp: string, password: string) =>
      await authorizeHttpGatewayConnect({
        auth: { mode: "password", password: "secret", allowTailscale: false },
        connectAuth: { password },
        req: request({ "x-forwarded-for": clientIp }),
        trustedProxies: ["127.0.0.1"],
        rateLimiter: limiter,
      });

    try {
      await expect(authorize("203.0.113.10", "wrong")).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
      await expect(authorize("203.0.113.11", "secret")).resolves.toMatchObject({
        ok: true,
        method: "password",
      });
      await expect(authorize("203.0.113.10", "secret")).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
    } finally {
      limiter.dispose();
    }
  });

  it("keeps genuinely direct loopback requests exempt from lockout", async () => {
    const limiter = createGatewayAuthRateLimiter(
      {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
      },
      { scheduler: createTestGatewayScheduler() },
    );
    const params = {
      auth: { mode: "password" as const, password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      req: request({ host: "127.0.0.1:18789" }),
      rateLimiter: limiter,
    };

    try {
      await expect(authorizeHttpGatewayConnect(params)).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
      await expect(authorizeHttpGatewayConnect(params)).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
    } finally {
      limiter.dispose();
    }
  });

  it.each([
    { allowRealIpFallback: false, token: "secret", reason: "proxy_attribution_required" },
    { allowRealIpFallback: true, token: "wrong", reason: "token_mismatch" },
  ])(
    "requires explicit X-Real-IP fallback: $allowRealIpFallback",
    async ({ allowRealIpFallback, token, reason }) => {
      const limiter = createLimiterSpy();
      const result = await authorizeWsControlUiGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: false },
        connectAuth: { token },
        req: request({ "x-real-ip": "203.0.113.77" }),
        trustedProxies: ["127.0.0.1"],
        allowRealIpFallback,
        rateLimiter: limiter,
      });
      expect(result).toEqual({ ok: false, reason });
      if (allowRealIpFallback) {
        expect(limiter.check).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
        expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
      } else {
        expect(limiter.check).not.toHaveBeenCalled();
        expect(limiter.reset).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      password: { source: "exec", provider: "op", id: "pw" } as const,
      error: /provider reference object/,
    },
    { password: undefined, error: /gateway auth mode is password, but no password was configured/ },
  ])("rejects unresolved password configuration: $password", ({ password, error }) => {
    const authConfig = { mode: "password" as const, password };
    const auth = resolveGatewayAuth({ authConfig, env: {} });
    expect(() => assertGatewayAuthConfigured(auth, authConfig)).toThrow(error);
  });
});

describe("trusted-proxy auth", () => {
  const trustedProxy = {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
  };
  const auth: GatewayConnectInput["auth"] = {
    mode: "trusted-proxy",
    allowTailscale: false,
    trustedProxy,
  };
  const identityHeaders = {
    "x-forwarded-user": "nick@example.com",
    "x-forwarded-proto": "https",
  };

  function mockLocalInterfaces(address = "10.0.0.2") {
    vi.mocked(os.networkInterfaces).mockReturnValue(
      makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address, family: "IPv4" }],
      }),
    );
  }
  beforeEach(() => {
    vi.spyOn(os, "networkInterfaces");
    mockLocalInterfaces();
  });
  afterEach(() => vi.restoreAllMocks());

  function authorizeTrustedProxy({
    remoteAddress = "10.0.0.1",
    headers = identityHeaders,
    ...options
  }: Partial<GatewayConnectInput> & {
    remoteAddress?: string;
    headers?: Parameters<typeof request>[0];
  } = {}) {
    return authorizeHttpGatewayConnect({
      auth,
      connectAuth: null,
      trustedProxies: [remoteAddress],
      req: request(
        { host: "gateway.local", "x-forwarded-for": "203.0.113.10", ...headers },
        remoteAddress,
      ),
      ...options,
    });
  }

  it("rejects trusted-proxy identity from a peer outside the proxy allowlist", async () => {
    await expect(
      authorizeTrustedProxy({
        remoteAddress: "192.168.1.100",
        trustedProxies: ["10.0.0.1"],
      }),
    ).resolves.toEqual({ ok: false, reason: "proxy_attribution_required" });
  });

  it("rejects trusted-proxy headers from the host non-loopback interface address", async () => {
    mockLocalInterfaces("10.0.0.1");
    await expect(authorizeTrustedProxy()).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_local_interface_source",
    });
  });

  it("rejects trusted-proxy headers when local interface discovery fails", async () => {
    vi.mocked(os.networkInterfaces).mockImplementation(() => {
      throw new Error("interface discovery failed");
    });
    await expect(authorizeTrustedProxy()).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_local_interface_check_failed",
    });
  });

  it.each([
    ["https://evil.example", { ok: false, reason: "trusted_proxy_origin_not_allowed" }],
    [
      "https://control.example.com",
      { ok: true, method: "trusted-proxy", user: "nick@example.com" },
    ],
  ])("checks the origin %s for an allowlisted proxy user", async (origin, expected) => {
    await expect(
      authorizeTrustedProxy({
        auth: { ...auth, trustedProxy: { ...trustedProxy, allowUsers: ["nick@example.com"] } },
        headers: {
          ...identityHeaders,
          host: "gateway.example.com",
          "x-forwarded-user": "  nick@example.com  ",
          origin,
        },
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin,
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toEqual(expected);
  });

  it("rejects request with missing user header", async () => {
    await expect(
      authorizeTrustedProxy({ headers: { "x-forwarded-proto": "https" } }),
    ).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_user_missing",
    });
  });

  it("rejects trusted-proxy mode with an environment token", () => {
    const resolved = resolveGatewayAuth({
      authConfig: { mode: "trusted-proxy", trustedProxy },
      env: { OPENCLAW_GATEWAY_TOKEN: "shared-secret" },
    });
    expect(resolved.mode).toBe("trusted-proxy");
    expect(resolved.token).toBe("shared-secret");
    expect(() => assertGatewayAuthConfigured(resolved)).toThrow(/mutually exclusive/);
  });

  it("still requires trustedProxy config before reporting a token conflict", () => {
    const resolved = resolveGatewayAuth({
      authConfig: { mode: "trusted-proxy", token: "shared-secret" },
    });
    expect(() => assertGatewayAuthConfigured(resolved)).toThrow(
      /no trustedProxy config was provided/,
    );
  });

  function authorizeLocalDirect(options: Partial<GatewayConnectInput> = {}) {
    return authorizeHttpGatewayConnect({
      auth: { ...auth, password: "local-password" },
      connectAuth: { password: "local-password" },
      trustedProxies: ["127.0.0.1"],
      req: request({ host: "localhost" }),
      ...options,
    });
  }

  it("rejects local-direct token auth even with a valid token", async () => {
    await expect(
      authorizeLocalDirect({
        auth: { ...auth, token: "secret", password: "local-password" },
        connectAuth: { token: "secret" },
      }),
    ).resolves.toEqual({ ok: false, reason: "trusted_proxy_loopback_source" });
  });

  it("accepts local-direct password fallback when trusted-proxy auth fails", async () => {
    const limiter = createLimiterSpy();
    await expect(
      authorizeLocalDirect({
        auth: {
          ...auth,
          password: "local-password",
          trustedProxy: { ...trustedProxy, allowLoopback: true },
        },
        rateLimiter: limiter,
      }),
    ).resolves.toEqual({ ok: true, method: "password" });
    expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
    expect(limiter.reset).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("rejects wrong local-direct password fallback and records the failure", async () => {
    const limiter = createLimiterSpy();
    await expect(
      authorizeLocalDirect({
        connectAuth: { password: "wrong-password" },
        rateLimiter: limiter,
        rateLimitScope: "custom-scope",
      }),
    ).resolves.toEqual({ ok: false, reason: "password_mismatch" });
    expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "custom-scope");
    expect(limiter.recordFailure).toHaveBeenCalledWith("127.0.0.1", "custom-scope");
    expect(limiter.reset).not.toHaveBeenCalled();
  });

  it("enforces rate-limit lockout before local-direct password fallback", async () => {
    const limiter = createLimiterSpy();
    limiter.check.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 2500 });
    await expect(authorizeLocalDirect({ rateLimiter: limiter })).resolves.toEqual({
      ok: false,
      reason: "rate_limited",
      rateLimited: true,
      retryAfterMs: 2500,
    });
    expect(limiter.recordFailure).not.toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "accepts identity",
      headers: identityHeaders,
      allowUsers: [],
      expected: { ok: true, method: "trusted-proxy", user: "nick@example.com" },
    },
    {
      name: "requires headers",
      headers: { "x-forwarded-user": "nick@example.com" },
      allowUsers: [],
      expected: { ok: false, reason: "trusted_proxy_missing_header_x-forwarded-proto" },
    },
    {
      name: "enforces allowUsers",
      headers: identityHeaders,
      allowUsers: ["admin@example.com"],
      expected: { ok: false, reason: "trusted_proxy_user_not_allowed" },
    },
  ])(
    "$name with an explicitly allowed loopback proxy",
    async ({ headers, allowUsers, expected }) => {
      await expect(
        authorizeTrustedProxy({
          remoteAddress: "127.0.0.1",
          headers,
          auth: { ...auth, trustedProxy: { ...trustedProxy, allowLoopback: true, allowUsers } },
        }),
      ).resolves.toEqual(expected);
    },
  );

  it("fails closed when forwarded headers are present but the client chain resolves to loopback", async () => {
    await expect(
      authorizeLocalDirect({
        req: request({
          host: "localhost",
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
        }),
      }),
    ).resolves.toEqual({ ok: false, reason: "proxy_attribution_required" });
  });

  it("still fails closed when trusted-proxy config is missing", async () => {
    await expect(
      authorizeLocalDirect({
        auth: { ...auth, trustedProxy: undefined, password: "local-password" },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_config_missing",
    });
  });

  it("still fails closed when trusted proxies are not configured", async () => {
    await expect(authorizeLocalDirect({ trustedProxies: [] })).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_no_proxies_configured",
    });
  });
});
