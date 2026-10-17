// WebSocket auth-context tests cover token, password, bootstrap, and device-token decision state.
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

const CLIENT_IP = "203.0.113.20";
const BOOTSTRAP_TOKEN = "bootstrap-token";
const DEVICE_TOKEN = "device-token";

function createTokenBucketRateLimiter(
  scopes: Partial<Record<TokenBucketScope, { allowed: boolean; retryAfterMs?: number }>> = {},
) {
  const configured: Record<string, { allowed: boolean; retryAfterMs?: number }> = scopes;
  const check = vi.fn((_ip: string | undefined, scope?: string) => {
    const cfg = configured[scope ?? ""] ?? { allowed: true };
    return { allowed: cfg.allowed, retryAfterMs: cfg.retryAfterMs ?? 5_000 };
  });
  const reset = vi.fn();
  const recordFailure = vi.fn();
  const recordFailureAndDelay = vi.fn<AuthRateLimiter["recordFailureAndDelay"]>(
    async (ip, scope) => {
      recordFailure(ip, scope);
    },
  );
  return {
    limiter: { check, reset, recordFailure, recordFailureAndDelay } as unknown as AuthRateLimiter,
    check,
    reset,
    recordFailure,
  };
}

function createBaseState(overrides?: Partial<ConnectAuthState>): ConnectAuthState {
  return {
    authResult: { ok: false, reason: "token_mismatch" },
    authOk: false,
    authMethod: "token",
    sharedAuthOk: false,
    pendingSharedAuthFailure: false,
    deviceTokenCandidate: "device-token",
    deviceTokenCandidateSource: "shared-token-fallback",
    ...overrides,
  };
}

function createBootstrapOnlyState(): Partial<ConnectAuthState> {
  return {
    bootstrapTokenCandidate: BOOTSTRAP_TOKEN,
    deviceTokenCandidate: undefined,
    deviceTokenCandidateSource: undefined,
  };
}

function createVerifyDeviceToken(
  result: DeviceTokenResult,
): ReturnType<typeof vi.fn<VerifyDeviceTokenFn>> {
  return vi.fn<VerifyDeviceTokenFn>(async () => result);
}

function createVerifyBootstrapToken(
  result: BootstrapTokenResult,
): ReturnType<typeof vi.fn<VerifyBootstrapTokenFn>> {
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
    state: createBaseState(params.stateOverrides),
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

async function resolveBootstrapCandidateDecision(params: {
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  verifyDeviceToken: VerifyDeviceTokenFn;
  rateLimiter?: AuthRateLimiter;
  withDeviceFallback?: boolean;
  sharedAuth?: boolean;
}) {
  return await resolveDeviceTokenDecision({
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken: params.verifyDeviceToken,
    rateLimiter: params.rateLimiter,
    clientIp: params.rateLimiter ? CLIENT_IP : undefined,
    role: params.sharedAuth ? "node" : "operator",
    scopes: params.sharedAuth ? [] : ["operator.read"],
    stateOverrides: {
      ...(params.withDeviceFallback
        ? { bootstrapTokenCandidate: BOOTSTRAP_TOKEN, deviceTokenCandidate: DEVICE_TOKEN }
        : createBootstrapOnlyState()),
      ...(params.sharedAuth
        ? {
            authResult: { ok: true, method: "tailscale" as const },
            authOk: true,
            authMethod: "tailscale" as const,
          }
        : {}),
    },
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
  const decision = await resolveBootstrapCandidateDecision({
    verifyBootstrapToken,
    verifyDeviceToken,
    rateLimiter: params.sharedAuth ? undefined : rateLimiter.limiter,
    withDeviceFallback: params.withDeviceFallback,
    sharedAuth: params.sharedAuth,
  });
  return { decision, verifyDeviceToken, rateLimiter, verifyBootstrapToken };
}

function expectBootstrapTokenAccepted(params: {
  decision: Awaited<ReturnType<typeof resolveConnectAuthDecision>>;
  verifyBootstrapToken: ReturnType<typeof vi.fn<VerifyBootstrapTokenFn>>;
  verifyDeviceToken: ReturnType<typeof vi.fn<VerifyDeviceTokenFn>>;
}) {
  expect(params.decision).toMatchObject({ authOk: true, authMethod: "bootstrap-token" });
  expect(params.verifyBootstrapToken).toHaveBeenCalledOnce();
  expect(params.verifyDeviceToken).not.toHaveBeenCalled();
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

      expect(decision.authOk).toBe(false);
      expect(decision.authResult.reason).toBe(reason);
      expect(verifyDeviceToken).not.toHaveBeenCalled();
      expect(verifyBootstrapToken).not.toHaveBeenCalled();
    },
  );

  it("reports explicit device-token mismatches as device_token_mismatch", async () => {
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken: createVerifyDeviceToken({ ok: false }),
      stateOverrides: {
        deviceTokenCandidateSource: "explicit-device-token",
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("device_token_mismatch");
  });

  it("preserves fallback device-token scope mismatches over shared-token mismatch", async () => {
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken: createVerifyDeviceToken({ ok: false, reason: "scope-mismatch" }),
      scopes: ["operator.admin"],
      stateOverrides: {
        authResult: { ok: false, reason: "token_mismatch" },
        deviceTokenCandidateSource: "shared-token-fallback",
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("scope_mismatch");
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createTokenBucketRateLimiter();
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: CLIENT_IP,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "device-token");
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createTokenBucketRateLimiter({
      "device-token": { allowed: false, retryAfterMs: 60_000 },
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: CLIENT_IP,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(60_000);
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("prefers a valid bootstrap token over an already successful shared auth path", async () => {
    expectBootstrapTokenAccepted(await resolveBootstrapFixture({ sharedAuth: true }));
  });

  it("keeps the original successful auth path when bootstrap validation fails", async () => {
    const { decision, verifyBootstrapToken, verifyDeviceToken } = await resolveBootstrapFixture({
      sharedAuth: true,
      invalid: true,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("tailscale");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("still verifies the device token when only the bootstrap-token path is rate-limited", async () => {
    const { decision, verifyBootstrapToken, verifyDeviceToken } = await resolveBootstrapFixture({
      blocked: true,
      withDeviceFallback: true,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("records a bootstrap-token failure when final auth rejects", async () => {
    const { rateLimiter } = await resolveBootstrapFixture({ invalid: true });
    expect(rateLimiter.recordFailure).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
    expect(rateLimiter.reset).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });

  it("does not record a bootstrap-token failure when device-token fallback succeeds", async () => {
    const { decision, rateLimiter } = await resolveBootstrapFixture({
      invalid: true,
      withDeviceFallback: true,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(rateLimiter.recordFailure).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });

  it("serializes concurrent bootstrap-token failures before checking the next attempt", async () => {
    const rateLimiter = createGatewayAuthRateLimiter(
      {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
        pruneIntervalMs: 0,
      },
      { scheduler: createTestGatewayScheduler() },
    );
    let activeBootstrapChecks = 0;
    let maxActiveBootstrapChecks = 0;
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => {
      activeBootstrapChecks += 1;
      maxActiveBootstrapChecks = Math.max(maxActiveBootstrapChecks, activeBootstrapChecks);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      activeBootstrapChecks -= 1;
      return { ok: false, reason: "bootstrap_token_invalid" };
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    try {
      const decisions = await Promise.all(
        Array.from(
          { length: 8 },
          async () =>
            await resolveDeviceTokenDecision({
              verifyBootstrapToken,
              verifyDeviceToken,
              rateLimiter,
              clientIp: CLIENT_IP,
              stateOverrides: createBootstrapOnlyState(),
            }),
        ),
      );
      const reasons = decisions.map((decision) => decision.authResult.reason);
      expect(reasons.filter((reason) => reason === "bootstrap_token_invalid")).toHaveLength(3);
      expect(reasons.filter((reason) => reason === "rate_limited")).toHaveLength(5);
      expect(verifyBootstrapToken).toHaveBeenCalledTimes(3);
      expect(maxActiveBootstrapChecks).toBe(1);
      expect(verifyDeviceToken).not.toHaveBeenCalled();
    } finally {
      rateLimiter.dispose();
    }
  });

  it("resets the bootstrap-token bucket when the verify succeeds", async () => {
    const result = await resolveBootstrapFixture();
    const { rateLimiter } = result;
    expectBootstrapTokenAccepted(result);
    expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
    expect(rateLimiter.recordFailure).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });
});
