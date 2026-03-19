import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import {
  resolveConnectAuthDecision,
  resolveConnectAuthState,
  type ConnectAuthState,
} from "./auth-context.js";

vi.mock("../../auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth.js")>();
  return {
    ...original,
    authorizeWsControlUiGatewayConnect: vi.fn<() => Promise<GatewayAuthResult>>(),
    authorizeHttpGatewayConnect: vi.fn<() => Promise<GatewayAuthResult>>(),
  };
});

async function importMockedAuth() {
  const mod = await import("../../auth.js");
  return {
    authorizeWsControlUiGatewayConnect: mod.authorizeWsControlUiGatewayConnect as ReturnType<
      typeof vi.fn<() => Promise<GatewayAuthResult>>
    >,
    authorizeHttpGatewayConnect: mod.authorizeHttpGatewayConnect as ReturnType<
      typeof vi.fn<() => Promise<GatewayAuthResult>>
    >,
  };
}

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];
type VerifyBootstrapTokenFn = Parameters<
  typeof resolveConnectAuthDecision
>[0]["verifyBootstrapToken"];

function createRateLimiter(params?: { allowed?: boolean; retryAfterMs?: number }): {
  limiter: AuthRateLimiter;
  reset: ReturnType<typeof vi.fn>;
} {
  const allowed = params?.allowed ?? true;
  const retryAfterMs = params?.retryAfterMs ?? 5_000;
  const check = vi.fn(() => ({ allowed, retryAfterMs }));
  const reset = vi.fn();
  const recordFailure = vi.fn();
  return {
    limiter: {
      check,
      reset,
      recordFailure,
    } as unknown as AuthRateLimiter,
    reset,
  };
}

function createBaseState(overrides?: Partial<ConnectAuthState>): ConnectAuthState {
  return {
    authResult: { ok: false, reason: "token_mismatch" },
    authOk: false,
    authMethod: "token",
    sharedAuthOk: false,
    sharedAuthProvided: true,
    deviceTokenCandidate: "device-token",
    deviceTokenCandidateSource: "shared-token-fallback",
    ...overrides,
  };
}

async function resolveDeviceTokenDecision(params: {
  verifyDeviceToken: VerifyDeviceTokenFn;
  verifyBootstrapToken?: VerifyBootstrapTokenFn;
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState(params.stateOverrides),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "operator",
    scopes: ["operator.read"],
    verifyBootstrapToken:
      params.verifyBootstrapToken ??
      (async () => ({ ok: false, reason: "bootstrap_token_invalid" })),
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
}

describe("resolveConnectAuthDecision", () => {
  it("keeps shared-secret mismatch when fallback device-token check fails", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState(),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("token_mismatch");
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("reports explicit device-token mismatches as device_token_mismatch", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        deviceTokenCandidateSource: "explicit-device-token",
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("device_token_mismatch");
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createRateLimiter();
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: "203.0.113.20",
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledOnce();
  });

  it("accepts valid bootstrap tokens before device-token fallback", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: "device-token",
      },
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("reports invalid bootstrap tokens when no device token fallback is available", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: undefined,
        deviceTokenCandidateSource: undefined,
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("bootstrap_token_invalid");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createRateLimiter({ allowed: false, retryAfterMs: 60_000 });
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: "203.0.113.20",
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(60_000);
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("returns the original decision when device fallback does not apply", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        authResult: { ok: true, method: "token" },
        authOk: true,
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: [],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("token");
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });
});

describe("resolveConnectAuthState – shared-secret rate limiting with device identity", () => {
  const fakeReq = {} as IncomingMessage;
  const fakeResolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "real-token",
    allowTailscale: false,
  };

  function createMockRateLimiter(): {
    limiter: AuthRateLimiter;
    recordFailure: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  } {
    const recordFailure = vi.fn();
    const check = vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 }));
    const reset = vi.fn();
    return {
      limiter: { check, recordFailure, reset, size: () => 0, prune: () => {}, dispose: () => {} },
      recordFailure,
      check,
      reset,
    };
  }

  it("records shared-secret failure when hasDeviceIdentity is true and auth fails", async () => {
    const { authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect } =
      await importMockedAuth();

    authorizeWsControlUiGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });
    authorizeHttpGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });

    const mock = createMockRateLimiter();
    const state = await resolveConnectAuthState({
      resolvedAuth: fakeResolvedAuth,
      connectAuth: { token: "wrong-token", deviceToken: "some-device-token" },
      hasDeviceIdentity: true,
      req: fakeReq,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter: mock.limiter,
      clientIp: "203.0.113.50",
    });

    expect(state.authOk).toBe(false);
    expect(mock.recordFailure).toHaveBeenCalledWith(
      "203.0.113.50",
      AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    );
  });

  it("does NOT record failure when hasDeviceIdentity is false (normal path)", async () => {
    const { authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect } =
      await importMockedAuth();

    authorizeWsControlUiGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });
    authorizeHttpGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });

    const mock = createMockRateLimiter();
    await resolveConnectAuthState({
      resolvedAuth: fakeResolvedAuth,
      connectAuth: { token: "wrong-token" },
      hasDeviceIdentity: false,
      req: fakeReq,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter: mock.limiter,
      clientIp: "203.0.113.51",
    });

    // The rate limiter was passed directly to authorizeWsControlUiGatewayConnect,
    // so recordFailure is handled inside that function, not in the else branch.
    expect(mock.recordFailure).not.toHaveBeenCalled();
  });

  it("resets rate limiter on success with device identity (existing behavior preserved)", async () => {
    const { authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect } =
      await importMockedAuth();

    authorizeWsControlUiGatewayConnect.mockResolvedValue({
      ok: true,
      method: "token",
    });
    authorizeHttpGatewayConnect.mockResolvedValue({
      ok: true,
      method: "token",
    });

    const mock = createMockRateLimiter();
    const state = await resolveConnectAuthState({
      resolvedAuth: fakeResolvedAuth,
      connectAuth: { token: "real-token", deviceToken: "some-device-token" },
      hasDeviceIdentity: true,
      req: fakeReq,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter: mock.limiter,
      clientIp: "203.0.113.52",
    });

    expect(state.authOk).toBe(true);
    expect(mock.recordFailure).not.toHaveBeenCalled();
    expect(mock.reset).toHaveBeenCalledWith("203.0.113.52", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
  });

  it("records failure with shared-token-fallback device candidate", async () => {
    const { authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect } =
      await importMockedAuth();

    // When only token is provided (no explicit deviceToken), the token is reused
    // as a shared-token-fallback device candidate.
    authorizeWsControlUiGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });
    authorizeHttpGatewayConnect.mockResolvedValue({
      ok: false,
      reason: "token_mismatch",
    });

    const mock = createMockRateLimiter();
    const state = await resolveConnectAuthState({
      resolvedAuth: fakeResolvedAuth,
      connectAuth: { token: "wrong-token" },
      hasDeviceIdentity: true,
      req: fakeReq,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter: mock.limiter,
      clientIp: "203.0.113.53",
    });

    expect(state.authOk).toBe(false);
    expect(mock.recordFailure).toHaveBeenCalledWith(
      "203.0.113.53",
      AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    );
  });
});
