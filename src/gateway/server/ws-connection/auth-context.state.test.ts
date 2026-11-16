import type { IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "../../auth-rate-limit.js";
import { markGatewayIngressTransport } from "../../ingress-attribution.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";

type ResolveConnectAuthStateParams = Parameters<typeof resolveConnectAuthState>[0];
const CLIENT_IP = "203.0.113.20";

function createLimiter({ allowed = true, retryAfterMs = 5_000 } = {}) {
  const recordFailure = vi.fn<AuthRateLimiter["recordFailure"]>();
  return {
    check: vi.fn<AuthRateLimiter["check"]>(() => ({ allowed, remaining: 10, retryAfterMs })),
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

async function resolveTokenAuthState(params: Partial<ResolveConnectAuthStateParams>) {
  return await resolveConnectAuthState({
    resolvedAuth: { mode: "token", token: "correct-secret", allowTailscale: false },
    connectAuth: {},
    hasDeviceIdentity: true,
    isUiAuthSurface: false,
    role: "node",
    req: { headers: {}, socket: { remoteAddress: CLIENT_IP } } as never,
    trustedProxies: [],
    allowRealIpFallback: false,
    rateLimiter: createLimiter(),
    clientIp: CLIENT_IP,
    ...params,
  });
}

function resolveDeviceAuth(
  state: Parameters<typeof resolveConnectAuthDecision>[0]["state"],
  rateLimiter: AuthRateLimiter,
) {
  return resolveConnectAuthDecision({
    state,
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "operator",
    scopes: ["operator.read"],
    verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
    verifyDeviceToken: async () => ({ ok: true }),
    rateLimiter,
    clientIp: CLIENT_IP,
  });
}

it("keeps managed Serve node credentials separate from verified Control UI identity", async () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.ts.net",
      "tailscale-user-login": "alice@github",
    },
  } as unknown as IncomingMessage;
  markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  const auth = {
    mode: "trusted-proxy" as const,
    allowTailscale: true,
    trustedProxy: {
      userHeader: "cf-access-authenticated-user-email",
      requiredHeaders: ["cf-access-jwt-assertion"],
      allowLoopback: true,
    },
  };
  const options = {
    resolvedAuth: auth,
    hasDeviceIdentity: true,
    isUiAuthSurface: false,
    role: "node",
    req,
    trustedProxies: ["127.0.0.1"],
    allowRealIpFallback: false,
  };
  const rateLimiter = createLimiter();

  const approvedNode = await resolveConnectAuthState({
    ...options,
    connectAuth: { deviceToken: "issued-node-token" },
    rateLimiter,
  });
  expect(approvedNode.authResult).toEqual({
    ok: false,
    reason: "trusted_proxy_missing_header_cf-access-jwt-assertion",
  });
  expect(approvedNode.authOk).toBe(false);
  const evaluate = (state: typeof approvedNode, tokenValid: boolean) =>
    resolveConnectAuthDecision({
      state,
      hasDeviceIdentity: true,
      deviceId: "approved-node",
      publicKey: "approved-pubkey",
      role: "node",
      scopes: [],
      verifyBootstrapToken: async () => ({ ok: false }),
      verifyDeviceToken: async () => (tokenValid ? { ok: true } : { ok: false }),
      rateLimiter,
      clientIp: "100.64.0.1",
    });
  await expect(evaluate(approvedNode, true)).resolves.toMatchObject({
    authOk: true,
    authMethod: "device-token",
  });

  const missingCredential = await resolveConnectAuthState({
    ...options,
    connectAuth: {},
    rateLimiter,
  });
  await expect(evaluate(missingCredential, true)).resolves.toMatchObject({ authOk: false });

  const revokedCredential = await resolveConnectAuthState({
    ...options,
    connectAuth: { deviceToken: "revoked-node-token" },
    rateLimiter,
  });
  await expect(evaluate(revokedCredential, false)).resolves.toMatchObject({
    authOk: false,
    authResult: { reason: "device_token_mismatch" },
  });
});

it("defers shared-secret failures when an explicit device token is also present", async () => {
  const rateLimiter = createLimiter();
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
  const rateLimiter = createLimiter({ allowed: false });

  const state = await resolveTokenAuthState({
    connectAuth: { deviceToken: "device-token-only" },
    rateLimiter,
  });

  expect(state.authOk).toBe(false);
  expect(state.authResult.rateLimited).not.toBe(true);
  expect(rateLimiter.check).not.toHaveBeenCalled();
});
it("sets sharedAuthOk false when auth mode is none (no shared secret provided)", async () => {
  const state = await resolveTokenAuthState({
    resolvedAuth: { mode: "none", allowTailscale: false },
    hasDeviceIdentity: false,
    req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never,
    clientIp: "127.0.0.1",
  });
  expect(state).toMatchObject({ authOk: true, authMethod: "none", sharedAuthOk: false });
});

it("does not reset the shared-secret limiter after device-token auth succeeds", async () => {
  const rateLimiter = createLimiter();
  await resolveDeviceAuth(
    {
      authResult: { ok: false, reason: "token_mismatch" },
      authOk: false,
      authMethod: "token",
      sharedAuthOk: false,
      pendingSharedAuthFailure: true,
      deviceTokenCandidate: "device-token",
      deviceTokenCandidateSource: "explicit-device-token",
    },
    rateLimiter,
  );

  expect(rateLimiter.reset).not.toHaveBeenCalledWith(CLIENT_IP, "shared-secret");
  expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "device-token");
});

it("does not let valid device reconnects consume remote shared-secret attempts", async () => {
  const limiter = createGatewayAuthRateLimiter(
    {
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    },
    { scheduler: createTestGatewayScheduler() },
  );
  try {
    limiter.recordFailure(CLIENT_IP, "shared-secret");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await resolveTokenAuthState({
        connectAuth: { token: "device", deviceToken: "device" },
        rateLimiter: limiter,
      });
      const decision = await resolveDeviceAuth(state, limiter);
      expect(decision.authOk).toBe(true);
    }

    expect(limiter.check(CLIENT_IP, "shared-secret")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  } finally {
    limiter.dispose();
  }
});
