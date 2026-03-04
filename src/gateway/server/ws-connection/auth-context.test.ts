import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { resolveConnectAuthDecision, type ConnectAuthState } from "./auth-context.js";

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];

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
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState(params.stateOverrides),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    role: "operator",
    scopes: ["operator.read"],
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
}

describe("resolveConnectAuthDecision", () => {
  it("keeps shared-secret mismatch when fallback device-token check fails", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState(),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("token_mismatch");
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
      role: "operator",
      scopes: ["operator.read"],
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
      role: "operator",
      scopes: [],
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("token");
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });
});
