import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewayProtocolResponseError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError as MockGatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";

const { gatewayClientState, createGatewayClientState } = vi.hoisted(() => {
  const createState = () => ({
    options: null as Record<string, unknown> | null,
    requests: [] as string[],
    startCalls: 0,
    startMode: "hello" as "hello" | "close" | "connect-error-close" | "defer",
    transportValidated: true,
    close: { code: 1008, reason: "pairing required" },
    helloAuth: { role: "operator", scopes: ["operator.read"] } as
      | { role?: string; scopes?: string[] }
      | undefined,
    connectError: "scope upgrade pending approval (requestId: req-123)",
    connectErrorDetails: {
      code: "PAIRING_REQUIRED",
      reason: "scope-upgrade",
      requestId: "req-123",
    } as Record<string, unknown> | null,
    requestError: null as { code: string; message: string; details?: unknown } | null,
    stopCalls: 0,
    stopAndWaitCalls: [] as Array<{ timeoutMs?: number } | undefined>,
    stopAndWaitMode: "resolve" as "resolve" | "reject",
  });
  return { gatewayClientState: createState(), createGatewayClientState: createState };
});

const { deviceIdentityState, createDeviceIdentityState, loadDeviceIdentity } = vi.hoisted(() => {
  const createState = () => ({
    value: { deviceId: "test-device-identity" } as Record<string, unknown>,
    throwOnLoad: false,
    cachedToken: {
      token: "cached-operator-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    } as Record<string, unknown> | null,
  });
  const state = createState();
  return {
    deviceIdentityState: state,
    createDeviceIdentityState: createState,
    loadDeviceIdentity: () => {
      if (state.throwOnLoad) {
        throw new Error("read-only identity dir");
      }
      return state.value;
    },
  };
});

const eventLoopReadyState = vi.hoisted(() => ({ ready: true, aborted: false }));

class MockGatewayClient {
  constructor(private readonly opts: Record<string, unknown>) {
    gatewayClientState.options = opts;
    gatewayClientState.requests = [];
  }

  private emit(name: string, ...args: unknown[]) {
    const callback = this.opts[name];
    if (typeof callback === "function") {
      return callback(...args);
    }
    return undefined;
  }

  start(): void {
    gatewayClientState.startCalls += 1;
    if (gatewayClientState.startMode === "defer") {
      return;
    }
    void Promise.resolve()
      .then(async () => {
        if (gatewayClientState.startMode === "connect-error-close") {
          const error = new MockGatewayClientRequestError({
            message: gatewayClientState.connectError,
            details: gatewayClientState.connectErrorDetails,
          });
          retainGatewayResponsePayload(error, undefined);
          this.emit("onConnectError", error);
        }
        if (gatewayClientState.startMode !== "hello") {
          this.emit("onClose", gatewayClientState.close.code, gatewayClientState.close.reason, {
            transportValidated: gatewayClientState.transportValidated,
          });
          return;
        }
        await this.emit("onHelloOk", {
          type: "hello-ok",
          server: { version: "2026.4.24", buildId: "build-test", connId: "conn-test" },
          auth: gatewayClientState.helloAuth,
        });
      })
      .catch(() => {});
  }

  stop(): void {
    gatewayClientState.stopCalls += 1;
  }

  async stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    gatewayClientState.stopAndWaitCalls.push(opts);
    if (gatewayClientState.stopAndWaitMode === "reject") {
      throw new Error("close drain failed");
    }
  }

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    if (gatewayClientState.requestError) {
      throw new MockGatewayClientRequestError(gatewayClientState.requestError);
    }
    return method === "system-presence" ? [] : {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
  GatewayClientRequestError: MockGatewayClientRequestError,
  isGatewayProtocolResponseError,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadOrCreateDeviceIdentityAsync: loadDeviceIdentity,
  loadDeviceIdentityIfPresentAsync: loadDeviceIdentity,
}));

// mock-isolation: Probe credentials come from the fixture, never the local device-auth store.
vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthTokenReadOnly: () => deviceIdentityState.cachedToken,
  loadOriginDeviceTokenReadOnly: () => null,
}));

// mock-isolation: Probe readiness comes from the fixture, not host timer drift.
vi.mock("../../packages/gateway-client/src/event-loop-ready.js", () => ({
  waitForEventLoopReady: async () => eventLoopReadyState,
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

type ProbeGatewayParams = Parameters<typeof probeGateway>[0];

function expectFields(result: unknown, fields: Record<string, unknown>): void {
  expect(result).toEqual(expect.objectContaining(fields));
}

let probeUrlSeq = 0;

function nextProbeUrl(label: string): string {
  return `ws://127.0.0.1:18789/${label}-${++probeUrlSeq}`;
}

function setDeviceRequiredProbeMode(): void {
  deviceIdentityState.cachedToken = null;
  gatewayClientState.startMode = "connect-error-close";
  gatewayClientState.close = { code: 1008, reason: "device identity required" };
  gatewayClientState.connectError = "gateway closed (1008): device identity required";
  gatewayClientState.connectErrorDetails = null;
}

const lastGatewayClientOptions = () => gatewayClientState.options;
const runLightweightProbe = (url: string) => runProbe({ url, includeDetails: false });

function runProbe(params: Partial<ProbeGatewayParams> = {}) {
  return probeGateway({ url: "ws://127.0.0.1:18789", timeoutMs: 1_000, ...params });
}

function runTokenProbe(params: Partial<ProbeGatewayParams> = {}) {
  return runProbe({ auth: { token: "secret" }, ...params });
}

function runTokenLightweightProbe(params: Partial<ProbeGatewayParams> = {}) {
  return runTokenProbe({ includeDetails: false, ...params });
}

async function primeDeviceRequiredProbeFailures(url: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await runLightweightProbe(url);
  }
}

function expectDeviceRequiredClose(
  result: Awaited<ReturnType<typeof probeGateway>>,
  hint?: string,
): void {
  const close = { code: 1008, reason: "device identity required" };
  expect(result.close).toEqual(hint ? { ...close, hint } : close);
}

describe("probeGateway", () => {
  beforeEach(() => {
    Object.assign(deviceIdentityState, createDeviceIdentityState());
    Object.assign(gatewayClientState, createGatewayClientState());
    Object.assign(eventLoopReadyState, { ready: true, aborted: false });
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });

  it("fails before connecting when event-loop readiness consumes the initial probe budget", async () => {
    eventLoopReadyState.ready = false;
    const result = await runProbe({ timeoutMs: 1, includeDetails: false });
    expectFields(result, { ok: false, error: "timeout", close: null });
    expectFields(result.auth, { role: null, scopes: [], capability: "unknown" });
    expect(gatewayClientState.startCalls).toBe(0);
  });

  it("stops an active probe when its owner aborts", async () => {
    gatewayClientState.startMode = "defer";
    const controller = new AbortController();
    const probe = runTokenLightweightProbe({
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(gatewayClientState.startCalls).toBe(1));
    controller.abort();
    await expect(probe).resolves.toMatchObject({ ok: false, error: "aborted" });
    expect(gatewayClientState.stopAndWaitCalls).toEqual([{ timeoutMs: 1_000 }]);
  });

  it("preserves structured missing-scope details from a post-connect request", async () => {
    const details = {
      code: "MISSING_SCOPE",
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    };
    gatewayClientState.helloAuth = { role: "operator", scopes: ["operator.write"] };
    gatewayClientState.requestError = {
      code: "FORBIDDEN",
      message: "permission denied",
      details,
    };
    const result = await runTokenProbe();
    expectFields(result, { ok: false, error: "permission denied" });
    expect(result.connectLatencyMs).not.toBeNull();
    expect(result.missingScopeErrorDetails).toEqual(details);
    expectFields(result.auth, { scopes: ["operator.write"], capability: "write_capable" });
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;
    const result = await runTokenProbe();
    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expectFields(result, { health: {}, status: {}, presence: [], configSnapshot: {} });
  });

  it.each([
    ["presence", "system-presence", { configSnapshot: null }],
    ["config", "config.get", { presence: null, configSnapshot: {} }],
  ] as const)("fetches only %s details", async (detailLevel, method, fields) => {
    const result = await runProbe({ detailLevel });
    expectFields(result, { ok: true, health: null, status: null, ...fields });
    expect(gatewayClientState.requests).toEqual([method]);
  });

  it.each([
    {
      name: "surfaces immediate close failures before the probe timeout",
      state: { startMode: "close" },
      expected: {
        ok: false,
        error: "gateway closed (1008): pairing required",
        close: { code: 1008, reason: "pairing required" },
        auth: expect.objectContaining({ capability: "pairing_pending" }),
      },
    },
    {
      name: "prefers the structured connect error over the generic close reason",
      state: { startMode: "connect-error-close", close: { code: 1008, reason: "connect failed" } },
      expected: {
        ok: false,
        error: "scope upgrade pending approval (requestId: req-123)",
        close: { code: 1008, reason: "connect failed" },
        auth: expect.objectContaining({ capability: "pairing_pending" }),
        connectLatencyMs: expect.any(Number),
      },
    },
    {
      name: "keeps probe capability unknown for temporary authentication lockouts",
      state: {
        startMode: "connect-error-close",
        connectError: "unauthorized: too many failed authentication attempts (retry later)",
        connectErrorDetails: { code: "AUTH_RATE_LIMITED" },
        close: { code: 1008, reason: "connect failed" },
      },
      expected: { ok: false, auth: expect.objectContaining({ capability: "unknown" }) },
    },
  ])("$name", async ({ state, expected }) => {
    Object.assign(gatewayClientState, state);
    expectFields(await runTokenLightweightProbe({ timeoutMs: 5_000 }), expected);
    expect(gatewayClientState.requests).toStrictEqual([]);
  });

  it("falls back to stop when close drain fails", async () => {
    gatewayClientState.stopAndWaitMode = "reject";
    const result = await runTokenLightweightProbe({
      url: nextProbeUrl("close-drain-fallback"),
    });
    expect(result.ok).toBe(true);
    expect(gatewayClientState.stopAndWaitCalls).toHaveLength(1);
    expect(gatewayClientState.stopCalls).toBe(1);
    expect(gatewayClientState.requests).toStrictEqual([]);
  });

  it("keeps capability unknown when hello-ok omits auth metadata", async () => {
    gatewayClientState.helloAuth = undefined;
    const result = await runTokenLightweightProbe();
    expectFields(result.auth, { role: null, scopes: [], capability: "unknown" });
  });

  it("short-circuits later unpaired probes after repeated device-required closes", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("device-required");
    for (let i = 0; i < 3; i += 1) {
      gatewayClientState.options = null;
      const result = await runLightweightProbe(url);

      expectFields(result, {
        ok: false,
        error: "gateway closed (1008): device identity required",
      });
      expectDeviceRequiredClose(result);
      expect(lastGatewayClientOptions()?.url).toBe(url);
    }
    const startCalls = gatewayClientState.startCalls;
    gatewayClientState.options = null;
    const result = await runLightweightProbe(url);
    expectFields(result, {
      ok: false,
      connectLatencyMs: null,
      error: "gateway closed (1008): device identity required",
      close: {
        code: 1008,
        reason: "device identity required",
        hint: "check short-circuited by recent device-required rejections",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    expectFields(result.auth, { role: null, scopes: [], capability: "unknown" });
    expect(gatewayClientState.startCalls).toBe(startCalls);
    expect(lastGatewayClientOptions()).toBeNull();
    expect(result.gatewayReached).toBeUndefined();
  });

  it("expires device-required probe cache entries after the TTL", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("ttl-device-required");
    let nowMs = 1_000_000;
    using _ = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await primeDeviceRequiredProbeFailures(url);

    nowMs += 5 * 60_000;
    gatewayClientState.options = null;
    const result = await runLightweightProbe(url);

    expectDeviceRequiredClose(result);
    expect(result.close?.hint).toBeUndefined();
    expect(lastGatewayClientOptions()?.url).toBe(url);
  });

  it("evicts the oldest device-required cache entries once the cap is reached", async () => {
    setDeviceRequiredProbeMode();
    const oldestUrl = nextProbeUrl("cache-oldest");
    const newestUrl = nextProbeUrl("cache-newest");
    const hint = "check short-circuited by recent device-required rejections";
    // Expiry must not masquerade as capacity eviction.
    using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await primeDeviceRequiredProbeFailures(oldestUrl);
    for (let i = 0; i < 499; i += 1) {
      await runLightweightProbe(nextProbeUrl(`cache-evict-${i}`));
    }
    const startsAtCapacity = gatewayClientState.startCalls;
    expectDeviceRequiredClose(await runLightweightProbe(oldestUrl), hint);
    expect(gatewayClientState.startCalls).toBe(startsAtCapacity);

    await primeDeviceRequiredProbeFailures(newestUrl);
    const startsAfterEviction = gatewayClientState.startCalls;
    expectDeviceRequiredClose(await runLightweightProbe(newestUrl), hint);
    expect(gatewayClientState.startCalls).toBe(startsAfterEviction);

    expectDeviceRequiredClose(await runLightweightProbe(oldestUrl));
    expect(gatewayClientState.startCalls).toBe(startsAfterEviction + 1);
    expect(lastGatewayClientOptions()?.url).toBe(oldestUrl);
  });

  it("lets paired probes clear prior device-required failures", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("paired-device-required");
    await primeDeviceRequiredProbeFailures(url);
    deviceIdentityState.cachedToken = createDeviceIdentityState().cachedToken;
    gatewayClientState.startMode = "hello";
    gatewayClientState.options = null;
    const success = await runLightweightProbe(url);
    expect(success.ok).toBe(true);
    expectFields(lastGatewayClientOptions(), {
      url,
      deviceIdentity: deviceIdentityState.value,
      sharedStateMode: "read-only",
    });
    setDeviceRequiredProbeMode();
    gatewayClientState.options = null;
    const afterSuccess = await runLightweightProbe(url);
    expectDeviceRequiredClose(afterSuccess);
    expect(afterSuccess.close?.hint).toBeUndefined();
    expect(lastGatewayClientOptions()?.url).toBe(url);
  });

  it("does not short-circuit explicit-auth probes after unauthenticated failures", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("explicit-auth-device-required");
    await primeDeviceRequiredProbeFailures(url);
    gatewayClientState.startMode = "hello";
    gatewayClientState.helloAuth = {};
    gatewayClientState.options = null;
    const result = await runTokenLightweightProbe({
      url,
      auth: { token: "explicit-token" },
    });
    expect(result.ok).toBe(true);
    expectFields(result.auth, {
      role: null,
      scopes: [],
      capability: "connected_no_operator_scope",
    });
    expectFields(lastGatewayClientOptions(), {
      url,
      token: "explicit-token",
      deviceIdentity: null,
    });
  });
});
