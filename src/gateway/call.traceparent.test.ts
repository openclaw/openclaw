import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import type { GatewayClientOptions, GatewayClientRequestOptions } from "./client.js";

type PrepareDeviceAuth = typeof import("./client.js").prepareGatewayClientDeviceAuth;
type TraceCallState = {
  starts: number;
  options?: GatewayClientOptions;
  requests: Array<{ method: string; params: unknown; options?: GatewayClientRequestOptions }>;
  events: string[];
};
const state = vi.hoisted(() => {
  const value: TraceCallState = { starts: 0, requests: [], events: [] };
  return value;
});
const prepareAuth = vi.hoisted(() => vi.fn<PrepareDeviceAuth>());
const stopAndWait = vi.hoisted(() => vi.fn<() => Promise<void>>());
const readConfig = vi.hoisted(() => vi.fn(() => ({})));
const readConfigAsync = vi.hoisted(() => vi.fn(async () => ({})));
const authStore = vi.hoisted(() => ({
  loadDeviceAuthToken: vi.fn<typeof import("../infra/device-auth-store.js").loadDeviceAuthToken>(),
  loadDeviceAuthTokenReadOnly:
    vi.fn<typeof import("../infra/device-auth-store.js").loadDeviceAuthTokenReadOnly>(),
  loadOriginDeviceToken:
    vi.fn<typeof import("../infra/device-auth-store.js").loadOriginDeviceToken>(),
  loadOriginDeviceTokenReadOnly:
    vi.fn<typeof import("../infra/device-auth-store.js").loadOriginDeviceTokenReadOnly>(),
}));
vi.mock("../infra/device-auth-store.js", () => {
  // Do not retain ambient environment values in mock-call failure diagnostics.
  function withoutEnv<P extends { env?: NodeJS.ProcessEnv }>(params: P): Omit<P, "env"> {
    const safe = { ...params };
    delete safe.env;
    return safe;
  }
  return {
    loadDeviceAuthToken: (params: Parameters<typeof authStore.loadDeviceAuthToken>[0]) =>
      authStore.loadDeviceAuthToken(withoutEnv(params)),
    loadDeviceAuthTokenReadOnly: (
      params: Parameters<typeof authStore.loadDeviceAuthTokenReadOnly>[0],
    ) => authStore.loadDeviceAuthTokenReadOnly(withoutEnv(params)),
    loadOriginDeviceToken: (params: Parameters<typeof authStore.loadOriginDeviceToken>[0]) =>
      authStore.loadOriginDeviceToken(withoutEnv(params)),
    loadOriginDeviceTokenReadOnly: (
      params: Parameters<typeof authStore.loadOriginDeviceTokenReadOnly>[0],
    ) => authStore.loadOriginDeviceTokenReadOnly(withoutEnv(params)),
  };
});
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: readConfig,
  readGatewayDispatchConfigWithShellEnvFallback: readConfigAsync,
}));
vi.mock("./client.js", () => ({
  prepareGatewayClientDeviceAuth: prepareAuth,
  isGatewayConnectAssemblyError: () => false,
  GatewayClient: class {
    constructor(options: GatewayClientOptions) {
      state.options = options;
    }
    start() {
      state.starts++;
      state.options?.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "fixture", connId: "fixture" },
        features: { methods: ["health"], capabilities: [], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: ["operator.read"] },
        policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
      } satisfies HelloOk);
    }
    async request(method: string, params: unknown, options?: GatewayClientRequestOptions) {
      state.events.push("request");
      state.requests.push({ method, params, options });
      return { ok: true };
    }
    async stopAndWait() {
      await stopAndWait();
    }
    stop() {}
  },
}));
vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false };
  },
}));
import { callGateway } from "./call.js";

const traceparent = "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01";
const explicitCall = {
  method: "health",
  url: "ws://127.0.0.1:18789",
  token: "fixture",
  config: {},
  deviceIdentity: null,
  sharedStateMode: "read-only",
  traceparent,
} as const;
const deviceIdentity: DeviceIdentity = {
  deviceId: "fixture-device",
  publicKeyPem: "fixture-public-key",
  privateKeyPem: "fixture-private-key",
};
const storedAuth: DeviceAuthEntry = {
  token: "fixture-origin-token",
  role: "operator",
  scopes: ["operator.read"],
  updatedAtMs: 1,
};
const originCall = {
  method: "health",
  url: "wss://fixture.example.invalid/gateway",
  config: {},
  deviceIdentity,
  sharedStateMode: "read-only",
  useStoredDeviceAuth: true,
  traceparent,
} as const;

function expectNoConnection() {
  expect(state.options).toBeUndefined();
  expect(state.starts).toBe(0);
  expect(state.requests).toEqual([]);
}

beforeEach(() => {
  state.starts = 0;
  state.options = undefined;
  state.requests = [];
  state.events = [];
  prepareAuth.mockReset().mockImplementation(async (_options, signal) => {
    signal?.throwIfAborted();
  });
  stopAndWait.mockReset().mockResolvedValue(undefined);
  readConfig.mockClear();
  readConfigAsync.mockClear();
  for (const mock of Object.values(authStore)) {
    mock.mockReset().mockResolvedValue(null);
  }
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("callGateway explicit diagnostic correlation", () => {
  it("forwards only to the requested method without changing params/auth options", async () => {
    const controller = new AbortController();
    const params = { unchanged: true };
    await callGateway({ ...explicitCall, params, signal: controller.signal });
    expect(state.requests).toEqual([
      {
        method: "health",
        params,
        options: expect.objectContaining({ traceparent, signal: controller.signal }),
      },
    ]);
    expect(prepareAuth).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: explicitCall.url,
        token: "fixture",
        deviceIdentity: null,
        sharedStateMode: "read-only",
      }),
      controller.signal,
    );
    expect(prepareAuth.mock.calls[0]?.[0]).not.toHaveProperty("traceparent");
    expect(prepareAuth.mock.calls[0]?.[0]).not.toHaveProperty("params");
    expect(state.options).toMatchObject({ url: explicitCall.url, token: "fixture" });
    expect(state.options).not.toHaveProperty("traceparent");
    for (const mock of Object.values(authStore)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it.each([
    "",
    "malformed",
    "x".repeat(129),
    "00-" + "0".repeat(32) + "-" + "2".repeat(16) + "-01",
  ])(
    "rejects malformed correlation before context or async auth work: %s",
    async (invalidTraceparent) => {
      await expect(
        callGateway({ method: "health", traceparent: invalidTraceparent }),
      ).rejects.toThrow("Invalid diagnostic traceparent.");
      expect(readConfig).not.toHaveBeenCalled();
      expect(readConfigAsync).not.toHaveBeenCalled();
      expect(prepareAuth).not.toHaveBeenCalled();
      for (const mock of Object.values(authStore)) {
        expect(mock).not.toHaveBeenCalled();
      }
      expectNoConnection();
    },
  );

  it("awaits exact-origin read-only auth before preparation without carrying the trace", async () => {
    const entered = createDeferred();
    const read = createDeferred<DeviceAuthEntry | null>();
    authStore.loadOriginDeviceTokenReadOnly.mockImplementationOnce(async () => {
      entered.resolve();
      return await read.promise;
    });
    const call = callGateway({ ...originCall, requiredStoredDeviceAuthScopes: ["operator.read"] });
    await entered.promise;
    expect(prepareAuth).not.toHaveBeenCalled();
    expectNoConnection();
    read.resolve(storedAuth);
    await expect(call).resolves.toEqual({ ok: true });
    expect(authStore.loadOriginDeviceTokenReadOnly).toHaveBeenCalledExactlyOnceWith({
      gatewayScope: originCall.url,
      deviceId: deviceIdentity.deviceId,
      role: "operator",
    });
    expect(authStore.loadDeviceAuthToken).not.toHaveBeenCalled();
    expect(authStore.loadDeviceAuthTokenReadOnly).not.toHaveBeenCalled();
    expect(authStore.loadOriginDeviceToken).not.toHaveBeenCalled();
    expect(prepareAuth.mock.calls[0]?.[0]).toMatchObject({
      preparedDeviceAuth: storedAuth,
      deviceAuthScope: originCall.url,
      sharedStateMode: "read-only",
    });
    expect(prepareAuth.mock.calls[0]?.[0]).not.toHaveProperty("traceparent");
    expect(state.options?.preparedDeviceAuth).toBe(storedAuth);
    expect(state.requests[0]?.options?.traceparent).toBe(traceparent);
  });

  it("awaits the authentication-availability helper before preparing the client", async () => {
    const entered = createDeferred();
    const read = createDeferred<DeviceAuthEntry | null>();
    authStore.loadOriginDeviceTokenReadOnly.mockImplementationOnce(async () => {
      entered.resolve();
      return await read.promise;
    });
    const call = callGateway({
      method: "health",
      config: {
        gateway: {
          mode: "remote",
          remote: { url: originCall.url },
          auth: { mode: "token", allowTailscale: false },
        },
      },
      skipImplicitAuth: true,
      deviceIdentity,
      sharedStateMode: "read-only",
      traceparent,
    });
    await entered.promise;
    expect(prepareAuth).not.toHaveBeenCalled();
    expectNoConnection();
    read.resolve(storedAuth);
    await expect(call).resolves.toEqual({ ok: true });
    expect(prepareAuth).toHaveBeenCalledOnce();
    expect(state.requests[0]?.options?.traceparent).toBe(traceparent);
  });

  it("waits for deferred preparation before starting the traced request", async () => {
    const entered = createDeferred();
    const preparation = createDeferred();
    prepareAuth.mockImplementationOnce(async () => {
      entered.resolve();
      await preparation.promise;
    });
    const call = callGateway(explicitCall);
    await entered.promise;
    expectNoConnection();
    preparation.resolve();
    await expect(call).resolves.toEqual({ ok: true });
    expect(state.starts).toBe(1);
    expect(state.requests[0]?.options?.traceparent).toBe(traceparent);
  });

  it("preserves explicit auth precedence and required scopes over stored auth", async () => {
    await callGateway({
      ...originCall,
      token: "fixture-explicit",
      requiredStoredDeviceAuthScopes: ["operator.read"],
    });
    expect(authStore.loadOriginDeviceTokenReadOnly).not.toHaveBeenCalled();
    expect(prepareAuth.mock.calls[0]?.[0]).toMatchObject({ token: "fixture-explicit" });
    expect(state.options).toMatchObject({ token: "fixture-explicit", scopes: ["operator.read"] });
    expect(state.options?.preparedDeviceAuth).toBeUndefined();
  });

  it("rejects target drift before stored auth lookup or preparation", async () => {
    await expect(
      callGateway({ ...originCall, expectUrl: "wss://other.example.invalid" }),
    ).rejects.toThrow("Gateway destination changed");
    expect(authStore.loadOriginDeviceTokenReadOnly).not.toHaveBeenCalled();
    expect(prepareAuth).not.toHaveBeenCalled();
    expectNoConnection();
  });

  it.each([
    {
      name: "missing origin token",
      entry: null,
      error: "No stored device auth for this gateway origin",
    },
    { name: "insufficient operator scopes", entry: storedAuth, error: "required operator scopes" },
  ])("does not bypass $name for a valid trace", async ({ entry, error }) => {
    authStore.loadOriginDeviceTokenReadOnly.mockResolvedValueOnce(entry);
    await expect(
      callGateway({ ...originCall, requiredStoredDeviceAuthScopes: ["operator.write"] }),
    ).rejects.toThrow(error);
    expect(prepareAuth).not.toHaveBeenCalled();
    expectNoConnection();
  });

  it("does not connect after cancellation during a deferred stored-token read", async () => {
    const entered = createDeferred();
    const read = createDeferred<DeviceAuthEntry | null>();
    const controller = new AbortController();
    const onSignalAbort = vi.fn();
    authStore.loadOriginDeviceTokenReadOnly.mockImplementationOnce(async () => {
      entered.resolve();
      return await read.promise;
    });
    const call = callGateway({ ...originCall, signal: controller.signal, onSignalAbort });
    const rejected = expect(call).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    controller.abort();
    expectNoConnection();
    // Join the owned read; this does not claim prompt settlement while storage is pending.
    read.resolve(storedAuth);
    await rejected;
    expect(prepareAuth.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(onSignalAbort).not.toHaveBeenCalled();
    expectNoConnection();
  });

  it.each(["resolve", "reject"] as const)(
    "does not connect after cancelled preparation later settles by %s",
    async (settlement) => {
      const entered = createDeferred();
      const preparation = createDeferred();
      const controller = new AbortController();
      prepareAuth.mockImplementationOnce(async (_options, signal) => {
        expect(signal).toBe(controller.signal);
        entered.resolve();
        await preparation.promise;
      });
      const call = callGateway({ ...explicitCall, signal: controller.signal });
      const rejected = expect(call).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      expectNoConnection();
      controller.abort();
      if (settlement === "resolve") {
        preparation.resolve();
      } else {
        preparation.reject(new Error("fixture preparation cancelled"));
      }
      await rejected;
      expectNoConnection();
    },
  );

  it("keeps the current-dispatch assertion synchronous with the primary request", async () => {
    await callGateway({
      ...explicitCall,
      assertDispatchCurrent: () => {
        state.events.push("assert-current");
        queueMicrotask(() => state.events.push("later-revocation"));
      },
    });
    expect(state.events).toEqual(["assert-current", "request", "later-revocation"]);
  });

  it("does not let a trace bypass a revoked dispatch claim", async () => {
    await expect(
      callGateway({
        ...explicitCall,
        assertDispatchCurrent: () => {
          throw new Error("fixture dispatch claim revoked");
        },
      }),
    ).rejects.toThrow("fixture dispatch claim revoked");
    expect(state.requests).toEqual([]);
    expect(stopAndWait).toHaveBeenCalledOnce();
  });

  it("joins owned client cleanup before settling a successful traced request", async () => {
    const entered = createDeferred();
    const cleanup = createDeferred();
    const completed = vi.fn();
    stopAndWait.mockImplementationOnce(async () => {
      entered.resolve();
      await cleanup.promise;
    });
    const call = callGateway(explicitCall).then(completed);
    await entered.promise;
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    cleanup.resolve();
    await call;
    expect(completed).toHaveBeenCalledWith({ ok: true });
    expect(stopAndWait).toHaveBeenCalledOnce();
  });
});
