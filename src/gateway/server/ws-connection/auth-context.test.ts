import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "../../auth-rate-limit.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";

type ConnectAuthState = Awaited<ReturnType<typeof resolveConnectAuthState>>;

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];
type VerifyBootstrapTokenFn = Parameters<
  typeof resolveConnectAuthDecision
>[0]["verifyBootstrapToken"];
type DeviceTokenResult = Awaited<ReturnType<VerifyDeviceTokenFn>>;
type BootstrapTokenResult = Awaited<ReturnType<VerifyBootstrapTokenFn>>;
type ConnectAuthRole = Parameters<typeof resolveConnectAuthDecision>[0]["role"];
type TokenBucketScope = "bootstrap-token" | "device-token" | "shared-secret";
type StateParams = Parameters<typeof resolveConnectAuthState>[0];

const CLIENT_IP = "203.0.113.20";
const BOOTSTRAP_TOKEN = "bootstrap-token";
const DEVICE_TOKEN = "device-token";

function createTokenBucketRateLimiter(
  scopes: Partial<Record<TokenBucketScope, { allowed: boolean; retryAfterMs?: number }>> = {},
) {
  const configured: Record<string, { allowed: boolean; retryAfterMs?: number }> = scopes;
  const recordFailure = vi.fn();
  return {
    check: vi.fn<AuthRateLimiter["check"]>((_ip, scope) => {
      const cfg = configured[scope ?? ""] ?? { allowed: true };
      return { allowed: cfg.allowed, remaining: 10, retryAfterMs: cfg.retryAfterMs ?? 5_000 };
    }),
    reset: vi.fn<AuthRateLimiter["reset"]>(),
    recordFailure,
    recordFailureAndDelay: vi.fn<AuthRateLimiter["recordFailureAndDelay"]>(async (ip, scope) => {
      recordFailure(ip, scope);
    }),
    size: vi.fn(() => 0),
    prune: vi.fn(),
    dispose: vi.fn(),
  };
}

function resolveTokenAuthState(params: Partial<StateParams>) {
  return resolveConnectAuthState({
    resolvedAuth: { mode: "token", token: "correct-secret", allowTailscale: false },
    connectAuth: {},
    hasDeviceIdentity: true,
    req: { headers: {}, socket: { remoteAddress: CLIENT_IP } } as never,
    trustedProxies: [],
    allowRealIpFallback: false,
    rateLimiter: createTokenBucketRateLimiter(),
    clientIp: CLIENT_IP,
    ...params,
  });
}

describe("resolveConnectAuthState", () => {
  it("defers shared-secret failures when an explicit device token is also present", async () => {
    const rateLimiter = createTokenBucketRateLimiter();
    const state = await resolveTokenAuthState({
      connectAuth: { token: "wrong-secret", deviceToken: "fake-device-token" },
      rateLimiter,
    });
    expect(state).toMatchObject({
      authOk: false,
      authResult: { reason: "token_mismatch" },
      pendingSharedAuthFailure: true,
    });
    expect(rateLimiter.recordFailure).not.toHaveBeenCalled();
  });

  it("does not apply shared-secret lockouts to explicit device-token-only handshakes", async () => {
    const rateLimiter = createTokenBucketRateLimiter({
      "shared-secret": { allowed: false },
    });
    const state = await resolveTokenAuthState({
      connectAuth: { deviceToken: "device-token-only" },
      rateLimiter,
    });
    expect(state.authOk).toBe(false);
    expect(state.authResult.rateLimited).not.toBe(true);
    expect(rateLimiter.check).not.toHaveBeenCalled();
  });

  it("sets sharedAuthOk false when auth mode is none (no shared secret provided)", async () => {
    expect(
      await resolveTokenAuthState({
        resolvedAuth: { mode: "none", allowTailscale: false },
        hasDeviceIdentity: false,
        req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never,
        clientIp: "127.0.0.1",
      }),
    ).toMatchObject({ authOk: true, authMethod: "none", sharedAuthOk: false });
  });

  it("does not let valid device reconnects consume remote shared-secret attempts", async () => {
    const rateLimiter = createGatewayAuthRateLimiter(
      { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000, pruneIntervalMs: 0 },
      { scheduler: createTestGatewayScheduler() },
    );
    try {
      rateLimiter.recordFailure(CLIENT_IP, "shared-secret");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await resolveTokenAuthState({
          connectAuth: { token: "device", deviceToken: "device" },
          rateLimiter,
        });
        const decision = await resolveDeviceTokenDecision({
          stateOverrides: state,
          verifyDeviceToken: createVerifyDeviceToken({ ok: true }),
          rateLimiter,
          clientIp: CLIENT_IP,
        });
        expect(decision.authOk).toBe(true);
      }
      expect(rateLimiter.check(CLIENT_IP, "shared-secret")).toMatchObject({
        allowed: true,
        remaining: 1,
      });
    } finally {
      rateLimiter.dispose();
    }
  });
});

const bootstrapOnly: Partial<ConnectAuthState> = {
  bootstrapTokenCandidate: BOOTSTRAP_TOKEN,
  deviceTokenCandidate: undefined,
  deviceTokenCandidateSource: undefined,
};

function createVerifyDeviceToken(result: DeviceTokenResult) {
  return vi.fn<VerifyDeviceTokenFn>(async () => result);
}

function createVerifyBootstrapToken(result: BootstrapTokenResult) {
  return vi.fn<VerifyBootstrapTokenFn>(async () => result);
}

async function resolveDeviceTokenDecision(params: {
  verifyDeviceToken: VerifyDeviceTokenFn;
  verifyBootstrapToken?: VerifyBootstrapTokenFn;
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  role?: ConnectAuthRole;
  scopes?: string[];
}) {
  return await resolveConnectAuthDecision({
    state: {
      authResult: { ok: false, reason: "token_mismatch" },
      authOk: false,
      authMethod: "token",
      sharedAuthOk: false,
      pendingSharedAuthFailure: false,
      deviceTokenCandidate: "device-token",
      deviceTokenCandidateSource: "shared-token-fallback",
      ...params.stateOverrides,
    },
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: params.role ?? "operator",
    scopes: params.scopes ?? ["operator.read"],
    verifyBootstrapToken:
      params.verifyBootstrapToken ??
      (async () => ({ ok: false, reason: "bootstrap_token_invalid" })),
    verifyDeviceToken: params.verifyDeviceToken,
    rateLimiter: params.rateLimiter,
    clientIp: params.clientIp,
  });
}

async function resolveBootstrapFixture(
  params: {
    blocked?: boolean;
    invalid?: boolean;
    withDeviceFallback?: boolean;
    sharedAuth?: boolean;
  } = {},
) {
  const rateLimiter = createTokenBucketRateLimiter(
    params.blocked ? { "bootstrap-token": { allowed: false, retryAfterMs: 30_000 } } : {},
  );
  const verifyBootstrapToken = createVerifyBootstrapToken(
    params.invalid ? { ok: false, reason: "bootstrap_token_invalid" } : { ok: true },
  );
  const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
  const decision = await resolveDeviceTokenDecision({
    verifyBootstrapToken,
    verifyDeviceToken,
    rateLimiter: params.sharedAuth ? undefined : rateLimiter,
    clientIp: params.sharedAuth ? undefined : CLIENT_IP,
    role: params.sharedAuth ? "node" : "operator",
    scopes: params.sharedAuth ? [] : ["operator.read"],
    stateOverrides: {
      ...(params.withDeviceFallback
        ? { bootstrapTokenCandidate: BOOTSTRAP_TOKEN, deviceTokenCandidate: DEVICE_TOKEN }
        : bootstrapOnly),
      ...(params.sharedAuth
        ? {
            authResult: { ok: true, method: "tailscale" as const },
            authOk: true,
            authMethod: "tailscale" as const,
          }
        : {}),
    },
  });
  return { decision, verifyDeviceToken, rateLimiter, verifyBootstrapToken };
}

describe("resolveConnectAuthDecision", () => {
  it.each(["proxy_attribution_required", "token_redacted_config", "password_redacted_config"])(
    "does not try credential fallbacks after %s",
    async (reason) => {
      const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
      const verifyBootstrapToken = createVerifyBootstrapToken({ ok: true });
      const decision = await resolveDeviceTokenDecision({
        verifyDeviceToken,
        verifyBootstrapToken,
        stateOverrides: {
          authResult: { ok: false, reason },
          bootstrapTokenCandidate: BOOTSTRAP_TOKEN,
        },
      });

      expect(decision).toMatchObject({ authOk: false, authResult: { reason } });
      expect(verifyDeviceToken).not.toHaveBeenCalled();
      expect(verifyBootstrapToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["explicit-device-token", "device_token_mismatch", { ok: false }, "operator.read"],
    [
      "shared-token-fallback",
      "scope_mismatch",
      { ok: false, reason: "scope-mismatch" },
      "operator.admin",
    ],
  ] as const)("reports %s rejection as %s", async (source, reason, result, scope) => {
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken: createVerifyDeviceToken(result),
      scopes: [scope],
      stateOverrides: { deviceTokenCandidateSource: source },
    });
    expect(decision).toMatchObject({ authOk: false, authResult: { reason } });
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createTokenBucketRateLimiter();
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter,
      clientIp: CLIENT_IP,
      stateOverrides: {
        pendingSharedAuthFailure: true,
        deviceTokenCandidateSource: "explicit-device-token",
      },
    });
    expect(decision).toMatchObject({ authOk: true, authMethod: "device-token" });
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "device-token");
    expect(rateLimiter.reset).not.toHaveBeenCalledWith(CLIENT_IP, "shared-secret");
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createTokenBucketRateLimiter({
      "device-token": { allowed: false, retryAfterMs: 60_000 },
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter,
      clientIp: CLIENT_IP,
    });
    expect(decision).toMatchObject({
      authOk: false,
      authResult: { reason: "rate_limited", retryAfterMs: 60_000 },
    });
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it.each([
    ["bootstrap-token", { sharedAuth: true }, 1, 0, false, false],
    ["tailscale", { sharedAuth: true, invalid: true }, 1, 0, false, false],
    ["device-token", { blocked: true, withDeviceFallback: true }, 0, 1, false, false],
    ["bootstrap-token", {}, 1, 0, true, false],
    [undefined, { invalid: true }, 1, 0, false, true],
    ["device-token", { invalid: true, withDeviceFallback: true }, 1, 1, false, false],
  ] as const)(
    "selects %s with bootstrap inputs %j",
    async (authMethod, params, bootstrapChecks, deviceChecks, resets, recordsFailure) => {
      const { decision, verifyBootstrapToken, verifyDeviceToken, rateLimiter } =
        await resolveBootstrapFixture(params);
      if (authMethod) {
        expect(decision).toMatchObject({ authOk: true, authMethod });
      }
      expect(verifyBootstrapToken).toHaveBeenCalledTimes(bootstrapChecks);
      expect(verifyDeviceToken).toHaveBeenCalledTimes(deviceChecks);
      if (resets) {
        expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
      }
      if (recordsFailure) {
        expect(rateLimiter.recordFailure).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
        expect(rateLimiter.reset).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
      } else if (resets || ("withDeviceFallback" in params && "invalid" in params)) {
        expect(rateLimiter.recordFailure).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
      }
    },
  );
});
