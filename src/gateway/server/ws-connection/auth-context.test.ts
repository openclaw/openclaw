import { describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, type AuthRateLimiter } from "../../auth-rate-limit.js";
import { resolveConnectAuthDecision, type ConnectAuthState } from "./auth-context.js";

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

function createFullRateLimiter(params?: { allowed?: boolean; retryAfterMs?: number }): {
  limiter: AuthRateLimiter;
  check: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  const allowed = params?.allowed ?? true;
  const retryAfterMs = params?.retryAfterMs ?? 5_000;
  const check = vi.fn(() => ({ allowed, retryAfterMs }));
  const reset = vi.fn();
  const recordFailure = vi.fn();
  return {
    limiter: { check, reset, recordFailure } as unknown as AuthRateLimiter,
    check,
    reset,
    recordFailure,
  };
}

async function resolveBootstrapDecision(params: {
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  verifyDeviceToken?: VerifyDeviceTokenFn;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState({
      bootstrapTokenCandidate: "bootstrap-token",
      deviceTokenCandidate: undefined,
      deviceTokenCandidateSource: undefined,
    }),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "operator",
    scopes: ["operator.read"],
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken: params.verifyDeviceToken ?? (async () => ({ ok: false })),
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
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

async function resolveSuccessfulNodeBootstrapDecision(params: {
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  verifyDeviceToken: VerifyDeviceTokenFn;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState({
      authResult: { ok: true, method: "tailscale" },
      authOk: true,
      authMethod: "tailscale",
      bootstrapTokenCandidate: "bootstrap-token",
      deviceTokenCandidate: undefined,
      deviceTokenCandidateSource: undefined,
    }),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "node",
    scopes: [],
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken: params.verifyDeviceToken,
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
    expect(rateLimiter.reset).toHaveBeenCalledWith("203.0.113.20", "device-token");
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

  it("still verifies the device token when only the shared-secret path is rate-limited", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      stateOverrides: {
        authResult: {
          ok: false,
          reason: "rate_limited",
          rateLimited: true,
          retryAfterMs: 60_000,
        },
      },
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("prefers a valid bootstrap token over an already successful shared auth path", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("keeps the original successful auth path when bootstrap validation fails", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("tailscale");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });
});

// ─── Bootstrap token rate limiting (unit) ────────────────────────────────────

describe("bootstrap token rate limiting", () => {
  it("does not call verify when bootstrap path is rate-limited", async () => {
    const rl = createFullRateLimiter({ allowed: false, retryAfterMs: 30_000 });
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const decision = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter: rl.limiter,
      clientIp: "192.0.2.1",
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(30_000);
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
  });

  it("records a failure on rejected bootstrap token", async () => {
    const rl = createFullRateLimiter({ allowed: true });
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const decision = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter: rl.limiter,
      clientIp: "192.0.2.1",
    });
    expect(decision.authOk).toBe(false);
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(rl.recordFailure).toHaveBeenCalledWith("192.0.2.1", "bootstrap-token");
    expect(rl.reset).not.toHaveBeenCalled();
  });

  it("resets the rate limit counter on successful bootstrap token", async () => {
    const rl = createFullRateLimiter({ allowed: true });
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const decision = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter: rl.limiter,
      clientIp: "192.0.2.1",
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(rl.reset).toHaveBeenCalledWith("192.0.2.1", "bootstrap-token");
    expect(rl.recordFailure).not.toHaveBeenCalled();
  });

  it("uses the bootstrap-token scope, not device-token", async () => {
    const rl = createFullRateLimiter({ allowed: true });
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter: rl.limiter,
      clientIp: "192.0.2.1",
    });
    expect(rl.check).toHaveBeenCalledWith("192.0.2.1", "bootstrap-token");
    expect(rl.check).not.toHaveBeenCalledWith(expect.anything(), "device-token");
  });

  it("does NOT record a bootstrap failure when the device-token fallback succeeds", async () => {
    // A device with a stale bootstrap token but a valid device token is a
    // legitimate user — charging the bootstrap scope would lock it out.
    const rl = createFullRateLimiter({ allowed: true });
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        bootstrapTokenCandidate: "stale-bootstrap",
        deviceTokenCandidate: "valid-device",
        deviceTokenCandidateSource: "explicit-device-token",
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken,
      verifyDeviceToken,
      rateLimiter: rl.limiter,
      clientIp: "192.0.2.5",
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(rl.recordFailure).not.toHaveBeenCalledWith("192.0.2.5", "bootstrap-token");
  });
});

// ─── Bootstrap token rate limiting (integration) ─────────────────────────────
//
// Uses a real AuthRateLimiter instance (not a mock) to prove that repeated
// failed bootstrap attempts trigger the lockout, and that the mutex-stall
// DoS vector (Finding 1) is blocked before verifyBootstrapToken is ever called.

describe("bootstrap token rate limiting — integration with real AuthRateLimiter", () => {
  it("locks out an attacker IP after repeated failed bootstrap attempts", async () => {
    const rateLimiter = createAuthRateLimiter({
      maxAttempts: 5,
      windowMs: 60_000,
      lockoutMs: 300_000,
    });

    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));

    const ATTACKER_IP = "203.0.113.99";

    // Burn through the allowed attempts
    for (let i = 0; i < 5; i++) {
      await resolveBootstrapDecision({
        verifyBootstrapToken,
        rateLimiter,
        clientIp: ATTACKER_IP,
      });
    }
    expect(verifyBootstrapToken).toHaveBeenCalledTimes(5);

    // 6th attempt: rate limiter fires, verify is NOT called
    verifyBootstrapToken.mockClear();
    const blocked = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter,
      clientIp: ATTACKER_IP,
    });

    expect(blocked.authOk).toBe(false);
    expect(blocked.authResult.reason).toBe("rate_limited");
    expect(blocked.authResult.retryAfterMs).toBeGreaterThan(0);
    expect(verifyBootstrapToken).not.toHaveBeenCalled();

    rateLimiter.dispose();
  });

  it("a different IP is unaffected while one IP is locked out", async () => {
    const rateLimiter = createAuthRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 300_000,
    });

    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));

    // Lock out attacker
    for (let i = 0; i < 3; i++) {
      await resolveBootstrapDecision({
        verifyBootstrapToken,
        rateLimiter,
        clientIp: "10.0.0.1",
      });
    }

    // Legitimate device from a different IP still gets through to verify
    verifyBootstrapToken.mockClear();
    const legit = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter,
      clientIp: "10.0.0.2",
    });

    expect(legit.authOk).toBe(false); // token is still invalid, but verify ran
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();

    rateLimiter.dispose();
  });

  it("legitimate device succeeds after attacker is locked out", async () => {
    const rateLimiter = createAuthRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 300_000,
    });

    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));

    // Lock out attacker IP
    for (let i = 0; i < 3; i++) {
      await resolveBootstrapDecision({
        verifyBootstrapToken,
        rateLimiter,
        clientIp: "10.0.0.99",
      });
    }

    // Legitimate device with correct token from clean IP succeeds
    verifyBootstrapToken.mockImplementation(async () => ({ ok: true }));
    verifyBootstrapToken.mockClear();

    const legit = await resolveBootstrapDecision({
      verifyBootstrapToken,
      rateLimiter,
      clientIp: "10.0.0.1",
    });

    expect(legit.authOk).toBe(true);
    expect(legit.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();

    rateLimiter.dispose();
  });
});
