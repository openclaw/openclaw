// Gateway call tests cover connection detail resolution, local/remote URL choice,
// auth token assembly, device identity, and client command metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { registerGatewayCallDeadlineTests } from "./call-deadline.test-support.js";
import { registerGatewayCallDispatchPreparationTests } from "./call-dispatch-preparation.test-support.js";
import { registerGatewayCallLocalBackendAuthTests } from "./call-local-backend-auth.test-support.js";
import type { GatewayClientOptions, GatewayClientRequestOptions } from "./client.js";
import { waitForFast } from "./client.test-support.js";
import {
  pickPrimaryLanIPv4Mock as pickPrimaryLanIPv4,
  pickPrimaryTailnetIPv4Mock as pickPrimaryTailnetIPv4,
} from "./gateway-connection.test-mocks.js";
import { createExpectedBroadOperatorScopes } from "./scope-expectations.test-support.js";

const TLS_FINGERPRINT = "ab".repeat(32);

const gatewayConfigMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  inspectGatewayTlsCertificate: vi.fn(),
  resolveConfigPath: vi.fn(
    (env: NodeJS.ProcessEnv, stateDir: string) =>
      env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
  ),
  resolveGatewayPort: vi.fn(),
  resolveStateDir: vi.fn((env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw"),
  useActualDispatchConfig: false,
}));
const getRuntimeConfig = gatewayConfigMocks.getRuntimeConfig;
const resolveGatewayPort = gatewayConfigMocks.resolveGatewayPort;

const deviceIdentityState = vi.hoisted(() => ({
  value: {
    deviceId: "test-device-identity",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  } satisfies DeviceIdentity,
}));
const loadOrCreateDeviceIdentityMock = vi.hoisted(() => vi.fn());
const loadDeviceIdentityIfPresentMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => DeviceAuthEntry | null>(() => null),
);
const loadDeviceAuthTokenReadOnlyMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => DeviceAuthEntry | null>(() => null),
);
const loadOriginDeviceTokenMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => DeviceAuthEntry | null>(() => null),
);
const loadOriginDeviceTokenReadOnlyMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => DeviceAuthEntry | null>(() => null),
);

const eventLoopReadyState = vi.hoisted(() => ({
  calls: [] as Array<{ maxWaitMs?: number } | undefined>,
  promise: null as Promise<{
    ready: boolean;
    elapsedMs: number;
    maxDriftMs: number;
    checks: number;
    aborted: boolean;
  }> | null,
  result: {
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  },
}));

const connectAssemblyErrorState = vi.hoisted(() => {
  const errors = new WeakSet<Error>();
  return {
    create(message: string): Error {
      const error = new Error(message);
      errors.add(error);
      return error;
    },
    has(value: unknown): value is Error {
      return value instanceof Error && errors.has(value);
    },
  };
});

vi.mock("../config/gateway-dispatch-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/gateway-dispatch-config.js")>();
  return {
    ...actual,
    readGatewayDispatchConfig: () =>
      gatewayConfigMocks.useActualDispatchConfig
        ? actual.readGatewayDispatchConfig()
        : gatewayConfigMocks.getRuntimeConfig(),
    readGatewayDispatchConfigWithShellEnvFallback: async () =>
      gatewayConfigMocks.useActualDispatchConfig
        ? await actual.readGatewayDispatchConfigWithShellEnvFallback()
        : gatewayConfigMocks.getRuntimeConfig(),
  };
});

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveConfigPath: gatewayConfigMocks.resolveConfigPath,
    resolveGatewayPort: gatewayConfigMocks.resolveGatewayPort,
    resolveStateDir: gatewayConfigMocks.resolveStateDir,
  };
});

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  return {
    ...actual,
    loadDeviceAuthToken: loadDeviceAuthTokenMock,
    loadDeviceAuthTokenReadOnly: loadDeviceAuthTokenReadOnlyMock,
    loadOriginDeviceToken: loadOriginDeviceTokenMock,
    loadOriginDeviceTokenReadOnly: loadOriginDeviceTokenReadOnlyMock,
  };
});

vi.mock("../infra/device-identity-async.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-identity-async.js")>();
  return {
    ...actual,
    loadOrCreateDeviceIdentityAsync: () => {
      loadOrCreateDeviceIdentityMock();
      return deviceIdentityState.value;
    },
    loadDeviceIdentityIfPresentAsync: () => {
      loadDeviceIdentityIfPresentMock();
      return deviceIdentityState.value;
    },
  };
});

vi.mock("../infra/tls/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/tls/gateway.js")>();
  return {
    ...actual,
    inspectGatewayTlsCertificate: gatewayConfigMocks.inspectGatewayTlsCertificate,
  };
});

let lastClientOptions: GatewayClientOptions | null = null;
let lastRequestOptions: {
  method?: string;
  params?: unknown;
  opts?: GatewayClientRequestOptions;
} | null = null;
type StartMode =
  | "hello"
  | "close"
  | "connect-error"
  | "connect-error-close"
  | "silent"
  | "clean-prehello-close-then-hello"
  | "repeated-clean-prehello-close";
let startMode: StartMode = "hello";
let startCalls = 0;
let closeCode = 1006;
let closeReason = "";
let helloCapabilities: string[] | undefined = [];
let helloMethods: string[] | undefined = ["health", "secrets.resolve"];
let connectError: Error | null = null;

function makeStubGatewayHello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { version: "test", connId: "test-connection" },
    features: { capabilities: helloCapabilities ?? [], methods: helloMethods ?? [], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
    },
    auth: { role: "operator", scopes: [] },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
  };
}

function startStubGatewayClient() {
  startCalls += 1;
  const cleanClose = () =>
    lastClientOptions?.onClose?.(1000, "", {
      phase: "pre-hello",
      socketOpened: true,
      transportValidated: true,
      connectRequestSent: true,
      transientPreHelloCleanClose: true,
    });
  if (
    startMode === "clean-prehello-close-then-hello" ||
    startMode === "repeated-clean-prehello-close"
  ) {
    cleanClose();
    if (startMode === "repeated-clean-prehello-close") {
      cleanClose();
      return;
    }
  }
  if (startMode === "hello" || startMode === "clean-prehello-close-then-hello") {
    lastClientOptions?.onHelloOk?.(makeStubGatewayHello());
  } else if (startMode === "connect-error" || startMode === "connect-error-close") {
    lastClientOptions?.onConnectError?.(
      connectError ?? connectAssemblyErrorState.create("device private key invalid"),
    );
    if (startMode === "connect-error-close") {
      lastClientOptions?.onClose?.(closeCode, closeReason, {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        transientPreHelloCleanClose: false,
      });
    }
  } else if (startMode === "close") {
    lastClientOptions?.onClose?.(closeCode, closeReason);
  }
}

type GatewayClientRequestImpl = (
  method: string,
  params: unknown,
  opts?: GatewayClientRequestOptions,
) => Promise<unknown>;
let gatewayClientRequest: GatewayClientRequestImpl = async (method, params, opts) => {
  lastRequestOptions = { method, params, opts };
  return { ok: true };
};
let gatewayClientStopAndWait = async () => {};

vi.mock("./client.js", () => ({
  prepareGatewayClientDeviceAuth: vi.fn(async () => {}),
  isGatewayConnectAssemblyError: (value: unknown) => connectAssemblyErrorState.has(value),
  GatewayClient: class {
    constructor(opts: GatewayClientOptions) {
      lastClientOptions = opts;
    }
    async request(method: string, params: unknown, opts?: GatewayClientRequestOptions) {
      return await gatewayClientRequest(method, params, opts);
    }
    start() {
      startStubGatewayClient();
    }
    stop() {}
    async stopAndWait() {
      await gatewayClientStopAndWait();
    }
  },
}));

vi.mock("../../packages/gateway-client/src/event-loop-ready.js", () => ({
  waitForEventLoopReady: vi.fn(async (params?: { maxWaitMs?: number }) => {
    eventLoopReadyState.calls.push(params);
    if (eventLoopReadyState.promise) {
      return await eventLoopReadyState.promise;
    }
    return eventLoopReadyState.result;
  }),
}));

const {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  callGatewayCli,
  formatGatewayAuthErrorJson,
  formatGatewayClientRequestErrorJson,
  formatGatewayTransportErrorJson,
  isImplicitLocalGatewayTarget,
  isGatewayTransportError,
} = await import("./call.js");

function deviceAuth(token = "paired-device-token", scopes = ["operator.read"]): DeviceAuthEntry {
  return { token, role: "operator", scopes, updatedAtMs: 123 };
}

function resetGatewayCallMocks() {
  getRuntimeConfig.mockReset().mockReturnValue({});
  resolveGatewayPort.mockReset().mockReturnValue(18789);
  gatewayConfigMocks.resolveConfigPath.mockClear();
  gatewayConfigMocks.resolveStateDir.mockClear();
  gatewayConfigMocks.inspectGatewayTlsCertificate
    .mockReset()
    .mockResolvedValue({ ok: false, error: "gateway tls is disabled" });
  gatewayConfigMocks.useActualDispatchConfig = false;
  pickPrimaryTailnetIPv4.mockClear();
  pickPrimaryLanIPv4.mockClear();
  lastClientOptions = null;
  lastRequestOptions = null;
  eventLoopReadyState.calls = [];
  eventLoopReadyState.promise = null;
  eventLoopReadyState.result = {
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  };
  startMode = "hello";
  startCalls = 0;
  closeCode = 1006;
  closeReason = "";
  helloCapabilities = [];
  helloMethods = ["health", "secrets.resolve"];
  connectError = null;
  gatewayClientRequest = async (method, params, opts) => {
    lastRequestOptions = { method, params, opts };
    return { ok: true };
  };
  gatewayClientStopAndWait = async () => {};
  loadOrCreateDeviceIdentityMock.mockReset();
  loadDeviceIdentityIfPresentMock.mockReset();
  loadDeviceAuthTokenMock.mockReset();
  loadDeviceAuthTokenMock.mockReturnValue(deviceAuth());
  loadDeviceAuthTokenReadOnlyMock.mockReset();
  loadDeviceAuthTokenReadOnlyMock.mockReturnValue(deviceAuth());
  loadOriginDeviceTokenMock.mockReset();
  loadOriginDeviceTokenMock.mockReturnValue(null);
  loadOriginDeviceTokenReadOnlyMock.mockReset();
  loadOriginDeviceTokenReadOnlyMock.mockReturnValue(null);
}

function setGatewayNetworkDefaults(port = 18789) {
  resolveGatewayPort.mockReturnValue(port);
  pickPrimaryTailnetIPv4.mockReturnValue(undefined);
}

function setGatewayConfig(gateway: NonNullable<OpenClawConfig["gateway"]>) {
  getRuntimeConfig.mockReturnValue({ gateway });
}

function setEnvSecretGatewayConfig(gateway: NonNullable<OpenClawConfig["gateway"]>) {
  const config = {
    gateway,
    secrets: { providers: { default: { source: "env" } } },
  } satisfies OpenClawConfig;
  getRuntimeConfig.mockReturnValue(config);
}

function setLocalLoopbackGatewayConfig(port = 18789) {
  setGatewayConfig({ mode: "local", bind: "loopback" });
  setGatewayNetworkDefaults(port);
}

function makeRemotePasswordGatewayConfig(remotePassword: string, localPassword = "from-config") {
  return {
    gateway: {
      mode: "remote",
      remote: { url: "wss://remote.example:18789", password: remotePassword },
      auth: { password: localPassword },
    },
  };
}

const envKeys = [
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_STATE_DIR",
  "LOCAL_REMOTE_FALLBACK_TOKEN",
  "LOCAL_REF_PASSWORD",
  "REMOTE_REF_TOKEN",
  "REMOTE_REF_PASSWORD",
  "LOCAL_FALLBACK_PASSWORD",
  "LOCAL_TRUSTED_PROXY_PASSWORD",
  "LOCAL_FALLBACK_REMOTE_TOKEN",
];
const envSnapshot = captureEnv(envKeys);
beforeEach(() => {
  resetConfigRuntimeState();
  envSnapshot.restore();
  for (const key of envKeys) {
    deleteTestEnvValue(key);
  }
  resetGatewayCallMocks();
});
afterEach(() => {
  resetConfigRuntimeState();
  envSnapshot.restore();
  vi.useRealTimers();
});

describe("callGateway url resolution", () => {
  it.each(["local config", "environment"])(
    "binds an observed %s endpoint without replacing its authentication",
    async (source) => {
      setGatewayNetworkDefaults();
      const expected =
        source === "local config" ? "ws://127.0.0.1:18789" : "wss://gateway.example/ws";
      if (source === "local config") {
        setGatewayConfig({ mode: "local", auth: { token: "fixture-local-token" } });
      } else {
        setGatewayConfig({
          mode: "remote",
          remote: { url: expected, token: "fixture-remote-token" },
        });
      }
      if (source === "environment") {
        process.env.OPENCLAW_GATEWAY_URL = expected;
        process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-env-token";
      }
      await callGateway({
        method: "chat.send",
        params: { message: "observed destination" },
        expectUrl: expected,
      });
      expect(lastClientOptions?.url).toBe(expected);
      expect(lastClientOptions?.token).toBe(
        source === "local config" ? "fixture-local-token" : "fixture-env-token",
      );

      // The user's snapshot names the first endpoint; a later CLI invocation
      // reloads configuration before sending its selected-session prompt.
      if (source === "environment") {
        process.env.OPENCLAW_GATEWAY_URL = "wss://replacement.example/ws";
      } else {
        setGatewayConfig({
          mode: "remote",
          remote: { url: "wss://replacement.example/ws", token: "fixture-replacement-token" },
        });
      }
      startCalls = 0;
      lastClientOptions = null;
      lastRequestOptions = null;
      await expect(
        callGateway({
          method: "chat.send",
          mode: GATEWAY_CLIENT_MODES.CLI,
          params: { message: "must not retarget" },
          expectUrl: expected,
        }),
      ).rejects.toThrow("Gateway destination changed");
      expect(startCalls).toBe(0);
      expect(lastClientOptions).toBeNull();
      expect(lastRequestOptions).toBeNull();
    },
  );

  it("does not disable an explicitly empty expected endpoint", async () => {
    const expectUrl = "";
    setLocalLoopbackGatewayConfig();
    await expect(callGateway({ method: "chat.send", expectUrl })).rejects.toThrow(
      "Gateway destination changed",
    );
    expect(startCalls).toBe(0);
    expect(lastRequestOptions).toBeNull();
  });

  it("classifies only the implicit configured local Gateway as local", async () => {
    setLocalLoopbackGatewayConfig();
    await expect(isImplicitLocalGatewayTarget({})).resolves.toBe(true);

    setGatewayConfig({ mode: "remote", remote: { url: "wss://gateway.example/ws" } });
    await expect(isImplicitLocalGatewayTarget({})).resolves.toBe(false);
    await expect(isImplicitLocalGatewayTarget({ localPortOverride: 19082 })).resolves.toBe(true);

    setLocalLoopbackGatewayConfig();
    await expect(isImplicitLocalGatewayTarget({ url: "ws://127.0.0.1:18789" })).resolves.toBe(
      false,
    );

    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway.example/ws";
    await expect(isImplicitLocalGatewayTarget({})).resolves.toBe(false);
  });

  it("keeps device identity for dotted-localhost shared-token auth", async () => {
    await callGateway({
      method: "health",
      url: "ws://localhost.:18789",
      token: "explicit-token",
    });

    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it.each([
    {
      url: "ws://127.0.0.1:18800",
      password: "test-password",
      token: undefined,
      readsConfig: false,
    },
    {
      url: "wss://override.example/ws",
      password: undefined,
      token: "test-token",
      readsConfig: true,
    },
  ])(
    "connects to $url despite an unreadable config",
    async ({ url, password, token, readsConfig }) => {
      getRuntimeConfig.mockImplementation(() => {
        throw new Error("invalid config");
      });
      await callGatewayCli({ method: "health", url, password, token });
      expect(getRuntimeConfig.mock.calls.length > 0).toBe(readsConfig);
      expect(lastClientOptions).toMatchObject({ url, password, token });
      expect(lastClientOptions?.edgeAuthHeaders).toBeUndefined();
    },
  );

  it("reconnects with admin only after sessions.create cwd returns structured escalation", async () => {
    const scopeAttempts: Array<readonly string[] | undefined> = [];
    gatewayClientRequest = async () => {
      scopeAttempts.push(lastClientOptions?.scopes);
      if (scopeAttempts.length === 1) {
        throw Object.assign(new Error("missing scope: operator.admin"), {
          name: "GatewayClientRequestError",
          gatewayCode: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
          retryable: false,
        });
      }
      return { key: "agent:main:dashboard:created" };
    };
    setLocalLoopbackGatewayConfig();

    await expect(
      callGatewayCli({
        method: "sessions.create",
        params: { cwd: "/outside/configured/workspaces" },
      }),
    ).resolves.toEqual({ key: "agent:main:dashboard:created" });

    expect(scopeAttempts).toEqual([["operator.write"], ["operator.admin"]]);
  });

  it.each(["token", "password"] as const)(
    "keeps %s auth preflight reads off writable shared state in read-only mode",
    async (authMode) => {
      setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: authMode } });
      setGatewayNetworkDefaults();
      loadDeviceAuthTokenReadOnlyMock.mockReturnValue(deviceAuth());
      loadDeviceAuthTokenMock.mockReturnValue(null);

      await callGateway({ method: "sessions.list", sharedStateMode: "read-only" });

      expect(loadDeviceAuthTokenReadOnlyMock).toHaveBeenCalledWith({
        deviceId: "test-device-identity",
        role: "operator",
        env: process.env,
      });
      expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
      expect(lastClientOptions?.sharedStateMode).toBe("read-only");
    },
  );

  it("fails before opening a websocket when default token auth has no shared or paired credential", async () => {
    setGatewayConfig({ mode: "local", bind: "loopback" });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue(null);

    const error = await callGateway({ method: "sessions.list" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "GatewayCredentialsRequiredError" });
    expect(formatGatewayAuthErrorJson(error)).toEqual({
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: expect.stringContaining("requires credentials before opening a websocket"),
      },
    });

    expect(lastClientOptions).toBeNull();
    expect(startCalls).toBe(0);
  });

  it("allows Tailscale Serve backend calls without explicit allowTailscale", async () => {
    setGatewayConfig({
      mode: "remote",
      remote: { url: "wss://openclaw.example.test" },
      auth: { mode: "token" },
      tailscale: { mode: "serve" },
    });
    setGatewayNetworkDefaults();

    await callGateway({ method: "sessions.list" });

    expect(lastClientOptions?.url).toBe("wss://openclaw.example.test");
    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("lets an explicit local port override bypass the configured remote URL", async () => {
    setGatewayConfig({
      mode: "remote",
      bind: "loopback",
      remote: { url: "wss://gateway.example/ws", token: "remote-token" },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      token: "explicit-token",
      localPortOverride: 19082,
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:19082");
    expect(lastClientOptions?.token).toBe("explicit-token");
  });

  it("uses remote tlsFingerprint with env URL override", async () => {
    setGatewayConfig({
      mode: "remote",
      remote: {
        url: "wss://remote.example:9443/ws",
        tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
      },
    });
    setGatewayNetworkDefaults(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.tlsFingerprint).toBe(TLS_FINGERPRINT);
  });

  it.each([
    ["plain environment inventory", "environments.list", {}, ["operator.read"]],
    [
      "runtime-aware environment inventory",
      "environments.list",
      { runtimeId: "openclaw" },
      ["operator.write"],
    ],
    [
      "profile dispatch",
      "sessions.dispatch",
      { key: "agent:main:thread", profileId: "development" },
      ["operator.admin"],
    ],
    [
      "profile move",
      "sessions.move",
      {
        key: "agent:main:thread",
        expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
        target: { kind: "profile", profileId: "development" },
      },
      ["operator.admin"],
    ],
    [
      "unclassified method",
      "plugin.custom.unclassified",
      undefined,
      createExpectedBroadOperatorScopes(),
    ],
    [
      "unresolved plugin action",
      "plugins.sessionAction",
      { pluginId: "remote-plugin", actionId: "approve" },
      createExpectedBroadOperatorScopes(),
    ],
  ] as const)("selects CLI scopes for %s", async (_name, method, params, scopes) => {
    setLocalLoopbackGatewayConfig();
    if (method === "plugins.sessionAction") {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
    await callGatewayCli({ method, params });
    expect(lastClientOptions?.scopes).toEqual(scopes);
  });

  it("passes explicit scopes through, including empty arrays", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "health", scopes: ["operator.read"] });
    expect(lastClientOptions?.scopes).toEqual(["operator.read"]);

    await callGateway({ method: "health", scopes: [] });
    expect(lastClientOptions?.scopes).toStrictEqual([]);
  });

  it("reuses stored device auth and scopes without resolving configured SecretRefs", async () => {
    setEnvSecretGatewayConfig({
      mode: "local",
      bind: "loopback",
      auth: {
        mode: "password",
        password: { source: "env", provider: "default", id: "MISSING_LOCAL_PASSWORD" },
      },
    });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue(
      deviceAuth("paired-device-token", ["operator.read", "operator.pairing"]),
    );

    await callGatewayCli({ method: "node.list", useStoredDeviceAuth: true });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
    expect(lastClientOptions?.scopes).toBeUndefined();
    expect(lastClientOptions?.preparedDeviceAuth).toEqual(
      deviceAuth("paired-device-token", ["operator.read", "operator.pairing"]),
    );
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it.each(["missing token", "missing scope", "different origin"] as const)(
    "rejects unavailable stored device auth: %s",
    async (failure) => {
      setLocalLoopbackGatewayConfig();
      if (failure === "missing token") {
        setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: "none" } });
        loadDeviceAuthTokenMock.mockReturnValue(null);
      }
      if (failure === "different origin") {
        loadOriginDeviceTokenMock.mockImplementation((...args: unknown[]) =>
          (args[0] as { gatewayScope: string }).gatewayScope === "wss://first.example/rpc"
            ? deviceAuth("first-origin-device-token")
            : null,
        );
      }
      const request = callGatewayCli({
        method: "node.list",
        useStoredDeviceAuth: true,
        ...(failure === "missing scope"
          ? { requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"] }
          : {}),
        ...(failure === "different origin"
          ? {
              url: "wss://fixture-user:fixture-password@second.example/rpc?token=fixture-query-secret",
            }
          : {}),
      });
      if (failure === "missing token") {
        await expect(request).rejects.toThrow("requires credentials before opening a websocket");
        expect(startCalls).toBe(0);
      } else {
        await expect(request).rejects.toMatchObject({
          name: "GatewayStoredDeviceAuthUnavailableError",
          ...(failure === "different origin"
            ? { message: expect.stringMatching(/^(?!.*fixture-).*tui --url/s) }
            : {}),
        });
      }
      if (failure === "different origin") {
        expect(loadOriginDeviceTokenMock).toHaveBeenCalledWith({
          gatewayScope: "wss://second.example/rpc",
          deviceId: deviceIdentityState.value.deviceId,
          role: "operator",
          env: process.env,
        });
      }
      expect(lastClientOptions).toBeNull();
    },
  );

  it("keeps remote CLI identity and stored auth reads off writable shared state", async () => {
    getRuntimeConfig.mockReturnValue(makeRemotePasswordGatewayConfig("remote-password"));
    setGatewayNetworkDefaults();
    loadOriginDeviceTokenReadOnlyMock.mockReturnValue(deviceAuth("remote-device-token"));

    await callGatewayCli({
      method: "node.list",
      useStoredDeviceAuth: true,
      sharedStateMode: "read-only",
    });

    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(lastClientOptions?.sharedStateMode).toBe("read-only");
    expect(loadDeviceIdentityIfPresentMock).toHaveBeenCalledOnce();
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(loadOriginDeviceTokenReadOnlyMock).toHaveBeenCalledWith({
      gatewayScope: "wss://remote.example:18789",
      deviceId: deviceIdentityState.value.deviceId,
      role: "operator",
      env: process.env,
    });
    expect(loadOriginDeviceTokenMock).not.toHaveBeenCalled();
  });

  it("isolates the accepted-hello observer from the RPC", async () => {
    let observedHello: HelloOk | undefined;
    const onHelloOk = vi.fn((hello: HelloOk) => {
      observedHello = hello;
      throw new Error("observer failed");
    });

    await expect(
      callGateway({
        method: "status",
        scopes: ["operator.read"],
        sharedStateMode: "read-only",
        preauthHandshakeTimeoutMs: 2_345,
        onHelloOk,
      }),
    ).resolves.toEqual({ ok: true });

    expect(onHelloOk).toHaveBeenCalledOnce();
    expect(observedHello).toEqual(makeStubGatewayHello());
    expect(lastRequestOptions?.method).toBe("status");
    expect(lastClientOptions?.sharedStateMode).toBe("read-only");
    expect(lastClientOptions?.preauthHandshakeTimeoutMs).toBe(2_345);
  });

  it("uses stored device auth for the exact normalized url override origin", async () => {
    setLocalLoopbackGatewayConfig();
    loadOriginDeviceTokenMock.mockImplementation((...args: unknown[]) =>
      (args[0] as { gatewayScope: string }).gatewayScope === "wss://other.example/rpc"
        ? deviceAuth("remote-device-token")
        : null,
    );

    await callGatewayCli({
      method: "node.list",
      url: "wss://other.example/rpc/?ignored=1",
      useStoredDeviceAuth: true,
    });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.deviceAuthScope).toBe("wss://other.example/rpc");
    expect(loadOriginDeviceTokenMock).toHaveBeenCalledWith({
      gatewayScope: "wss://other.example/rpc",
      deviceId: deviceIdentityState.value.deviceId,
      role: "operator",
      env: process.env,
    });
  });

  it("lets explicit url auth win while binding issued tokens to that origin", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayCli({
      method: "node.list",
      url: "wss://other.example/rpc/?ignored=1",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
    });

    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceAuthScope).toBe("wss://other.example/rpc");
    expect(lastClientOptions?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(loadOriginDeviceTokenMock).not.toHaveBeenCalled();
  });

  registerGatewayCallLocalBackendAuthTests({
    callGateway,
    setGatewayConfig,
    setGatewayNetworkDefaults,
    setLocalLoopbackGatewayConfig,
    getRuntimeConfig,
    getClientOptions: () => lastClientOptions,
    getDeviceIdentity: () => deviceIdentityState.value,
    loadOrCreateDeviceIdentityMock,
    loadDeviceIdentityIfPresentMock,
    loadDeviceAuthTokenMock,
    loadDeviceAuthTokenReadOnlyMock,
    loadOriginDeviceTokenMock,
  });

  it("sends internal agent handoffs as backend gateway calls", async () => {
    setLocalLoopbackGatewayConfig();
    helloMethods = ["agent"];

    await callGateway({
      method: "agent",
      params: {
        message: "resume",
        sessionEffects: "internal",
        suppressPromptPersistence: true,
      },
    });

    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.clientDisplayName).toBe("gateway:agent");
    expect(lastRequestOptions?.method).toBe("agent");
    expect(lastRequestOptions?.params).toMatchObject({
      sessionEffects: "internal",
      suppressPromptPersistence: true,
    });
  });

  it("passes approval runtime tokens to backend gateway clients", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "exec.approval.waitDecision",
      scopes: ["operator.approvals"],
      approvalRuntimeToken: "runtime-token",
    });

    expect(lastClientOptions?.approvalRuntimeToken).toBe("runtime-token");
  });
});

describe("buildGatewayConnectionDetails", () => {
  it.each(["local TLS", "local port override", "bound remote"] as const)(
    "resolves probe details for %s",
    async (target) => {
      const config: OpenClawConfig = {
        gateway:
          target === "bound remote"
            ? { mode: "remote", remote: { url: "wss://selected-gateway.example/ws" } }
            : {
                mode: "local",
                bind: "loopback",
                ...(target === "local TLS" ? { tls: { enabled: true } } : {}),
              },
      };
      if (target === "local TLS") {
        resolveGatewayPort.mockReturnValue(18800);
        gatewayConfigMocks.inspectGatewayTlsCertificate.mockResolvedValue({
          ok: true,
          value: { cert: "public-certificate", fingerprintSha256: TLS_FINGERPRINT },
        });
      } else {
        process.env.OPENCLAW_GATEWAY_URL = "wss://unrelated-gateway.example/ws";
        if (target === "local port override") {
          process.env.OPENCLAW_GATEWAY_PORT = "19001";
          resolveGatewayPort.mockImplementation((_config?: unknown, env?: unknown) =>
            Number((env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_GATEWAY_PORT ?? 18789),
          );
        }
      }
      const details = await buildGatewayProbeConnectionDetails({
        config,
        ...(target === "local port override" ? { localPortOverride: 19082 } : {}),
        ...(target === "bound remote" ? { ignoreEnvUrlOverride: true } : {}),
      });
      expect(details.url).toBe(
        target === "local TLS"
          ? "wss://127.0.0.1:18800"
          : target === "local port override"
            ? "ws://127.0.0.1:19082"
            : "wss://selected-gateway.example/ws",
      );
      if (target === "local TLS") {
        expect(details.tlsFingerprint).toBe(TLS_FINGERPRINT);
        expect(details.preauthHandshakeTimeoutMs).toBeUndefined();
      } else {
        expect(details.urlSource).toBe(
          target === "bound remote" ? "config gateway.remote.url" : "local loopback",
        );
      }
    },
  );

  it("keeps service target diagnostics authoritative over remote and env URLs", () => {
    const config = {
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: {
          url: "wss://remote-gateway.example/ws",
          token: "remote-token",
        },
      },
    } satisfies OpenClawConfig;
    resolveGatewayPort.mockReturnValue(19191);
    process.env.OPENCLAW_GATEWAY_URL = "wss://env-gateway.example/ws";

    const details = buildGatewayConnectionDetails({
      config,
      serviceTargetUrl: "wss://service-gateway.example:19191",
    });

    expect(details.url).toBe("wss://service-gateway.example:19191");
    expect(details.urlSource).toBe("service target");
    expect(details.remoteFallbackNote).toBeUndefined();
    expect(details.message).not.toContain("remote-gateway.example");
  });

  it("redacts credential-bearing target URLs from connection messages", () => {
    setLocalLoopbackGatewayConfig(18800);

    const details = buildGatewayConnectionDetails({
      url: "wss://user:pass@example.com/ws?token=secret-token&keep=visible",
    });

    expect(details.url).toBe("wss://user:pass@example.com/ws?token=secret-token&keep=visible");
    expect(details.message).toContain(
      "Gateway target: wss://***:***@example.com/ws?token=***&keep=visible",
    );
    expect(details.message).not.toContain("user:pass");
    expect(details.message).not.toContain("secret-token");
  });

  it("emits a remote fallback note when remote url is missing", () => {
    setGatewayConfig({ mode: "remote", bind: "loopback", remote: {} });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
    expect(details.urlSource).toBe("missing gateway.remote.url (fallback local)");
    expect(details.bindDetail).toBe("Bind: loopback");
    expect(details.remoteFallbackNote).toContain(
      "gateway.mode=remote but gateway.remote.url is missing",
    );
    expect(details.message).toContain("Gateway target: ws://127.0.0.1:18789");
  });

  it.each([false, true])(
    "loads dispatch config with runtime snapshot=%s",
    async (runtimeSnapshot) => {
      const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-call-"));
      const configPath = path.join(tempStateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", bind: "loopback", port: 18800, auth: { mode: "none" } },
          ...(!runtimeSnapshot ? { channels: { telegram: { dmPolicy: 42 } } } : {}),
        }),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      if (runtimeSnapshot) {
        setRuntimeConfigSnapshot({
          gateway: { mode: "local", bind: "loopback", port: 18801, auth: { mode: "none" } },
        });
      }
      try {
        gatewayConfigMocks.useActualDispatchConfig = true;
        loadDeviceAuthTokenMock.mockReturnValue(null);
        resolveGatewayPort.mockImplementation((config) => config?.gateway?.port ?? 18789);
        await expect(callGateway({ method: "health" })).resolves.toEqual({ ok: true });
        expect(lastClientOptions?.url).toBe(`ws://127.0.0.1:${runtimeSnapshot ? 18801 : 18800}`);
        expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
      } finally {
        resetConfigRuntimeState();
        fs.rmSync(tempStateDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["ws://10.0.0.8:18789", false],
    ["ws://openclaw-gateway.ai:18789", true],
  ] as const)("allows trusted remote URL %s (opt-in=%s)", (url, optIn) => {
    if (optIn) {
      process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    }
    setGatewayConfig({ mode: "remote", bind: "loopback", remote: { url } });
    resolveGatewayPort.mockReturnValue(18789);
    const details = buildGatewayConnectionDetails();
    expect(details.url).toBe(url);
    expect(details.urlSource).toBe("config gateway.remote.url");
  });

  it("redacts credential-bearing target URLs from insecure ws:// errors", () => {
    setGatewayConfig({
      mode: "remote",
      bind: "loopback",
      remote: { url: "ws://user:pass@remote.example.com:18789/ws?token=secret-token" },
    });
    resolveGatewayPort.mockReturnValue(18789);

    expect(() => buildGatewayConnectionDetails()).toThrow(
      'Gateway URL "ws://***:***@remote.example.com:18789/ws?token=***" uses plaintext',
    );
    try {
      buildGatewayConnectionDetails();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("user:pass");
      expect((error as Error).message).not.toContain("secret-token");
    }
  });
});

describe("callGateway error details", () => {
  it.each(["close", "hello"] as const)(
    "preserves close details and scopes outcome guidance to dispatch (%s)",
    async (mode) => {
      startMode = mode;
      closeCode = 1006;
      closeReason = "";
      setLocalLoopbackGatewayConfig();
      const dispatched = createDeferred();
      gatewayClientRequest = () => {
        dispatched.resolve();
        return createDeferred<unknown>().promise;
      };
      const result = callGateway({ method: "health" }).catch((caught: unknown) => caught);
      if (mode === "hello") {
        await dispatched.promise;
        lastClientOptions?.onClose?.(1006, "");
      }
      const error = await result;
      if (!isGatewayTransportError(error)) {
        throw new Error("Expected a Gateway close");
      }
      expect(error.name).toBe("GatewayTransportError");
      expect(error.message).toContain("Gateway target: ws://127.0.0.1:18789");
      expect(error.message).toContain("Source: local loopback");
      expect(error.message).toContain("Bind: loopback");
      const requestDispatched = mode === "hello";
      expect(error.message.includes("outcome is unknown")).toBe(requestDispatched);
      expect(error.message.includes("Verify the current state")).toBe(requestDispatched);
      expect(error.message.includes("(retry;")).toBe(!requestDispatched);
      expect(error.message.includes("Gateway not yet ready")).toBe(!requestDispatched);
      expect(error.message.includes("TLS mismatch")).toBe(!requestDispatched);
      expect(formatGatewayTransportErrorJson(error)).toEqual({
        ok: false,
        error: {
          type: "gateway_transport_error",
          kind: "closed",
          message: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
          code: 1006,
          reason: "no close reason",
        },
        gateway: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          bindDetail: "Bind: loopback",
        },
      });
    },
  );

  it.each(["clean-prehello-close-then-hello", "repeated-clean-prehello-close"] as const)(
    "handles transient pre-hello closes: %s",
    async (mode) => {
      startMode = mode;
      setLocalLoopbackGatewayConfig();
      const request = callGateway({ method: "health" });
      if (mode === "clean-prehello-close-then-hello") {
        await expect(request).resolves.toEqual({ ok: true });
        expect(lastRequestOptions?.method).toBe("health");
      } else {
        await expect(request).rejects.toThrow(
          "gateway closed (1000 normal closure): no close reason",
        );
        expect(lastRequestOptions).toBeNull();
      }
    },
  );

  it.each(["assembly", "rate limit", "runtime identity", "stored device"] as const)(
    "surfaces the original %s connection error",
    async (failure) => {
      setLocalLoopbackGatewayConfig();
      startMode = failure === "rate limit" ? "connect-error-close" : "connect-error";
      const rateLimitDetails = {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      };
      const identityMessage =
        "gateway rejected required agent runtime identity auth field; refusing to retry without it";
      if (failure === "assembly") {
        connectError = connectAssemblyErrorState.create("device private key invalid");
      } else if (failure === "rate limit") {
        closeCode = 1008;
        closeReason = "unauthorized: too many failed authentication attempts (retry later)";
        connectError = Object.assign(new Error(closeReason), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: rateLimitDetails,
          retryable: true,
          retryAfterMs: 60_000,
        });
      } else if (failure === "runtime identity") {
        connectError = new Error(identityMessage);
      } else {
        connectError = Object.assign(new Error("unauthorized: device token mismatch"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
        });
        vi.useFakeTimers();
      }
      const request =
        failure === "stored device"
          ? callGatewayCli({ method: "node.list", timeoutMs: 5, useStoredDeviceAuth: true })
          : callGateway({
              method: failure === "runtime identity" ? "cron.remove" : "health",
              ...(failure === "assembly" ? { timeoutMs: 10_000 } : {}),
              ...(failure === "runtime identity"
                ? { token: "explicit-token", agentRuntimeIdentityToken: "identity-token" }
                : {}),
            });
      const result = request.catch((caught: unknown) => caught);
      if (failure === "stored device") {
        await vi.advanceTimersByTimeAsync(5);
      }
      const error = await result;
      expect(error).toBe(connectError);
      if (failure === "assembly") {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("device private key invalid");
        expect(formatGatewayAuthErrorJson(error)).toBeNull();
      } else if (failure === "rate limit") {
        expect(formatGatewayClientRequestErrorJson(error)).toEqual({
          ok: false,
          error: {
            type: "gateway_request_error",
            code: "INVALID_REQUEST",
            message: "unauthorized: too many failed authentication attempts (retry later)",
            details: {
              code: "AUTH_RATE_LIMITED",
              authReason: "rate_limited",
              recommendedNextStep: "wait_then_retry",
            },
            retryable: true,
            retryAfterMs: 60_000,
          },
        });
      } else if (failure === "runtime identity") {
        expect(error).toMatchObject({ message: identityMessage });
        expect(lastClientOptions?.agentRuntimeIdentityToken).toBe("identity-token");
      } else {
        expect(error).toMatchObject({
          name: "GatewayClientRequestError",
          details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
        });
      }
      expect(lastRequestOptions).toBeNull();
    },
  );

  it.each(["upgrade rejection", "connection refusal"] as const)(
    "surfaces %s from close info",
    async (failure) => {
      startMode = "silent";
      setLocalLoopbackGatewayConfig();
      const code = "ECONNREFUSED";
      const cause =
        failure === "upgrade rejection"
          ? Object.assign(
              new Error(
                "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
              ),
              {
                name: "GatewayClientRequestError",
                gatewayCode: "UNAVAILABLE",
                details: { reason: "websocket-upgrade-rejected", httpStatus: 503 },
                retryable: true,
              },
            )
          : Object.assign(new Error(`connect ${code} 127.0.0.1:18789`), { code });
      const request = callGateway({ method: "health" });
      await waitForFast(() => expect(lastClientOptions).not.toBeNull());
      lastClientOptions?.onClose?.(1006, "", {
        phase: "pre-hello",
        socketOpened: false,
        transportValidated: false,
        transientPreHelloCleanClose: false,
        connectError: cause,
      });
      const error = await request.catch((caught: unknown) => caught);
      if (failure === "upgrade rejection") {
        expect(error).toBe(cause);
      } else {
        expect(isGatewayTransportError(error)).toBe(true);
        expect(error).toMatchObject({ kind: "closed" });
        expect(error).not.toHaveProperty("code");
        const message = (error as Error).message;
        expect(message).toContain(`Gateway not reachable at ws://127.0.0.1:18789 (${code}).`);
        expect(message).toContain(
          "Start it with `openclaw gateway run` or check `openclaw gateway status`.",
        );
        expect(message).not.toContain(`connect ${code}`);
      }
    },
  );

  it.each([
    {
      name: "another structured auth rejection",
      error: Object.assign(new Error("unauthorized: gateway token mismatch"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { code: "AUTH_TOKEN_MISMATCH" },
        retryable: false,
      }),
    },
    { name: "ordinary connect error", error: new Error("ordinary connect failure") },
  ])("keeps $name on the existing transport-close path", async ({ error: connectFailure }) => {
    startMode = "connect-error-close";
    closeCode = 1008;
    closeReason = "connect failed";
    connectError = connectFailure;
    setLocalLoopbackGatewayConfig();

    let error: unknown;
    await callGateway({ method: "health" }).catch((caught: unknown) => {
      error = caught;
    });

    expect(formatGatewayTransportErrorJson(error)).toEqual({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1008): connect failed",
        code: 1008,
        reason: "connect failed",
      },
      gateway: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        bindDetail: "Bind: loopback",
      },
    });
  });

  registerGatewayCallDeadlineTests(() => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();
    return {
      call: callGateway,
      formatError: formatGatewayTransportErrorJson,
      setRequest: (request) => {
        gatewayClientRequest = request;
      },
      setStop: (stop) => {
        gatewayClientStopAndWait = stop;
      },
      startCalls: () => startCalls,
      hello: () => lastClientOptions?.onHelloOk?.(makeStubGatewayHello()),
    };
  });

  it("redacts credential-bearing URLs echoed in remote close reasons", async () => {
    startMode = "close";
    closeCode = 1008;
    closeReason = "rejected ws://user:secret@gw.example.com:18789?token=abc123";
    setLocalLoopbackGatewayConfig();

    let err: unknown;
    await callGateway({ method: "health" }).catch((caught: unknown) => {
      err = caught;
    });

    const json = formatGatewayTransportErrorJson(err);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("abc123");
    expect(json?.error.reason).toContain("ws://***:***@gw.example.com:18789?token=***");
    expect(json?.error.message).toContain("ws://***:***@gw.example.com:18789?token=***");
  });

  it("rejects malformed request errors in CLI JSON output", () => {
    for (const fields of [{ retryable: "no" }, { retryable: false, retryAfterMs: -1 }]) {
      expect(
        formatGatewayClientRequestErrorJson(
          Object.assign(new Error("unauthorized role: operator"), {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            ...fields,
          }),
        ),
      ).toBeNull();
    }
  });

  it.each(["pending", "exhausted"] as const)(
    "charges %s event-loop readiness against the wrapper timeout",
    async (readiness) => {
      startMode = "silent";
      setLocalLoopbackGatewayConfig();
      if (readiness === "pending") {
        eventLoopReadyState.promise = new Promise(() => {});
      } else {
        eventLoopReadyState.result = {
          ready: false,
          elapsedMs: 5,
          maxDriftMs: 400,
          checks: 1,
          aborted: false,
        };
      }
      vi.useFakeTimers();
      const promise = callGateway({ method: "health", timeoutMs: 5 }).catch(
        (caught: unknown) => caught,
      );
      await waitForFast(() => expect(eventLoopReadyState.calls).toHaveLength(1));
      expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(5);
      expect(startCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(5);
      const error = await promise;
      expect(isGatewayTransportError(error)).toBe(true);
      expect(error).toMatchObject({
        name: "GatewayTransportError",
        kind: "timeout",
        timeoutMs: 5,
        message: expect.stringContaining("gateway timeout after 5ms"),
      });
      expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
      expect(startCalls).toBe(0);
    },
  );

  it.each(["handshake environment", "large timeout", "disabled request timeout"] as const)(
    "retains a safe startup deadline with %s",
    async (mode) => {
      const handshakeEnv = captureEnv(["OPENCLAW_HANDSHAKE_TIMEOUT_MS"]);
      try {
        if (mode === "handshake environment") {
          process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "30000";
        }
        startMode = "silent";
        setLocalLoopbackGatewayConfig();
        vi.useFakeTimers();
        let error: unknown;
        const promise = callGateway({
          method: "health",
          ...(mode === "large timeout" ? { timeoutMs: 2_592_010_000 } : {}),
          ...(mode === "disabled request timeout" ? { timeoutMs: null } : {}),
        }).catch((caught: unknown) => {
          error = caught;
        });
        if (mode === "handshake environment") {
          await vi.advanceTimersByTimeAsync(10_000);
          expect(error).toBeUndefined();
          await vi.advanceTimersByTimeAsync(20_000);
        } else if (mode === "large timeout") {
          await vi.advanceTimersByTimeAsync(1);
          expect(error).toBeUndefined();
          lastClientOptions?.onClose?.(1006, "");
        } else {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        await promise;
        if (mode === "disabled request timeout") {
          expect(isGatewayTransportError(error)).toBe(true);
          expect(error).toMatchObject({ kind: "timeout", timeoutMs: 10_000 });
          expect(lastRequestOptions).toBeNull();
        } else {
          expect(error).toMatchObject({
            message: expect.stringContaining(
              mode === "large timeout" ? "gateway closed (1006" : "gateway timeout after 30000ms",
            ),
          });
        }
      } finally {
        handshakeEnv.restore();
      }
    },
  );

  it("returns a catalog refresh after the passive-read deadline", async () => {
    setLocalLoopbackGatewayConfig();
    vi.useFakeTimers();
    const response = { models: [{ provider: "fixture", id: "refreshed", name: "Refreshed" }] };
    const pending = createDeferred<typeof response>();
    helloMethods = ["models.list"];
    gatewayClientRequest = async (method, params, requestOpts) => {
      lastRequestOptions = { method, params, opts: requestOpts };
      return await pending.promise;
    };
    const result = callGateway({
      method: "models.list",
      params: { refresh: true },
      timeoutMs: 210_000,
    });
    const outcome = expect(result).resolves.toEqual(response);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(lastRequestOptions?.method).toBe("models.list");
    pending.resolve(response);
    await outcome;
  });

  it("disables the request and wrapper deadline when timeout is null", async () => {
    setLocalLoopbackGatewayConfig();
    vi.useFakeTimers();
    let releaseRequest: (() => void) | undefined;

    gatewayClientRequest = async (method, params, requestOpts) => {
      lastRequestOptions = { method, params, opts: requestOpts };
      await new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      return { ok: true };
    };

    let settled = false;
    const promise = callGateway({ method: "health", timeoutMs: null }).then((result) => {
      settled = true;
      return result;
    });

    await waitForFast(() => {
      expect(lastRequestOptions?.opts?.timeoutMs).toBeNull();
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    if (!releaseRequest) {
      throw new Error("Expected request release callback to be initialized");
    }
    releaseRequest();
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("runs the signal abort hook on the active gateway connection before teardown", async () => {
    setLocalLoopbackGatewayConfig();

    const controller = new AbortController();
    const abortRequests: Array<{
      method: string;
      params: unknown;
      opts?: { timeoutMs?: number | null };
    }> = [];
    let stopStarted = false;

    gatewayClientRequest = async (method, params, requestOpts) => {
      lastRequestOptions = { method, params, opts: requestOpts };
      if (method === "agent") {
        return await new Promise((_, reject) => {
          requestOpts?.signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("gateway request aborted for agent");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      }
      abortRequests.push({ method, params, opts: requestOpts });
      return { ok: true };
    };
    gatewayClientStopAndWait = async () => {
      stopStarted = true;
    };

    const promise = callGateway({
      method: "agent",
      expectFinal: true,
      signal: controller.signal,
      onSignalAbort: async (request) => {
        await request("chat.abort", { sessionKey: "main", runId: "run-1" }, { timeoutMs: 5_000 });
      },
    });

    await waitForFast(() => {
      expect(lastRequestOptions?.method).toBe("agent");
    });
    controller.abort();

    await expect(promise).rejects.toThrow("gateway request aborted for agent");
    expect(abortRequests).toEqual([
      {
        method: "chat.abort",
        params: { sessionKey: "main", runId: "run-1" },
        opts: { timeoutMs: 5_000 },
      },
    ]);
    expect(stopStarted).toBe(true);
  });

  registerGatewayCallDispatchPreparationTests(() => {
    setLocalLoopbackGatewayConfig();
    return {
      call: callGateway,
      request: () => lastRequestOptions,
      setRequest: (request) => {
        gatewayClientRequest = request;
      },
      setStop: (stop) => {
        gatewayClientStopAndWait = stop;
      },
      setFeatures: (methods, capabilities) => {
        helloMethods = methods;
        helloCapabilities = capabilities;
      },
      hello: () => lastClientOptions?.onHelloOk?.(makeStubGatewayHello()),
      close: (code, reason) => lastClientOptions?.onClose?.(code, reason),
    };
  });

  it("clears the wrapper timeout and joins gateway teardown before resolving", async () => {
    setLocalLoopbackGatewayConfig();
    vi.useFakeTimers();
    const stopping = createDeferred();
    const stopped = createDeferred();
    gatewayClientStopAndWait = () => {
      stopping.resolve();
      return stopped.promise;
    };
    let settled = false;
    const promise = callGateway({ method: "health", timeoutMs: 5 }).then((result) => {
      settled = true;
      return result;
    });
    await stopping.promise;
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    stopped.resolve();
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("fails fast when remote mode is missing remote url", async () => {
    setGatewayConfig({ mode: "remote", bind: "loopback", remote: {} });
    await expect(
      callGateway({
        method: "health",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("gateway remote mode misconfigured");
  });
});

describe("callGateway url override auth requirements", () => {
  it.each(["cli", "env"] as const)("requires credentials for a %s URL override", async (source) => {
    const url = "wss://override.example/ws";
    if (source === "cli") {
      process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
      process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password";
    } else {
      process.env.OPENCLAW_GATEWAY_URL = url;
    }
    setGatewayConfig({ mode: "local", auth: { token: "local-token", password: "local-password" } });
    const error = await callGateway({
      method: "health",
      ...(source === "cli" ? { url } : {}),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: expect.stringMatching(
        source === "cli"
          ? /remove --url to use the configured target/i
          : /OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD/i,
      ),
    });
    expect(formatGatewayAuthErrorJson(error)).toEqual({
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: expect.stringContaining("gateway url override requires explicit credentials"),
      },
    });
  });
});

type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
const secretRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const localAuth = (
  auth: GatewayConfig["auth"],
  remote?: GatewayConfig["remote"],
): GatewayConfig => ({
  mode: "local",
  bind: "loopback",
  auth,
  remote,
});
const remoteAuth = (remote: GatewayConfig["remote"]): GatewayConfig => ({
  mode: "remote",
  bind: "loopback",
  auth: {},
  remote: { url: "wss://remote.example:18789", ...remote },
});

describe("callGateway password resolution", () => {
  it.each([
    ["local", "from-config"],
    ["remote", "from-env"],
  ])("uses password precedence in %s mode", async (mode, expected) => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    getRuntimeConfig.mockReturnValue(
      mode === "local"
        ? { gateway: localAuth({ password: "from-config" }) }
        : makeRemotePasswordGatewayConfig("remote-secret"),
    );
    await callGateway({ method: "health" });
    expect(lastClientOptions?.password).toBe(expected);
  });

  it.each(["password", "token"] as const)(
    "does not let fallback credentials mask an unresolved local %s ref",
    async (authMode) => {
      if (authMode === "password") {
        process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
      } else {
        process.env.LOCAL_REMOTE_FALLBACK_TOKEN = "resolved-local-remote-fallback-token";
      }
      setEnvSecretGatewayConfig(
        authMode === "password"
          ? localAuth({ mode: "password", password: secretRef("MISSING_LOCAL_REF_PASSWORD") })
          : localAuth(
              { mode: "token", token: secretRef("MISSING_LOCAL_REF_TOKEN") },
              { token: secretRef("LOCAL_REMOTE_FALLBACK_TOKEN") },
            ),
      );
      const error = await callGateway({ method: "health" }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "GatewaySecretRefUnavailableError",
        path: `gateway.auth.${authMode}`,
      });
      expect(formatGatewayAuthErrorJson(error)).toEqual({
        ok: false,
        error: {
          type: "gateway_credentials_required",
          message: expect.stringContaining(
            `gateway.auth.${authMode} is configured as a secret reference but is unavailable`,
          ),
        },
      });
    },
  );

  it.each<[string, GatewayConfig, Record<string, string>, string | undefined, string | undefined]>([
    [
      "does not resolve local password ref when token auth can win",
      localAuth({
        mode: "token",
        token: "token-auth",
        password: secretRef("MISSING_LOCAL_REF_PASSWORD"),
      }),
      {},
      "token-auth",
      undefined,
    ],
    [
      "resolves local password ref before unresolved local token ref can block auth",
      localAuth({
        token: secretRef("MISSING_LOCAL_REF_TOKEN"),
        password: secretRef("LOCAL_FALLBACK_PASSWORD"),
      }),
      { LOCAL_FALLBACK_PASSWORD: "resolved-local-fallback-password" },
      undefined,
      "resolved-local-fallback-password",
    ],
    [
      "resolves local password refs when auth mode is trusted-proxy",
      localAuth({ mode: "trusted-proxy", password: secretRef("LOCAL_TRUSTED_PROXY_PASSWORD") }),
      { LOCAL_TRUSTED_PROXY_PASSWORD: "resolved-trusted-proxy-password" },
      undefined,
      "resolved-trusted-proxy-password",
    ],
    [
      "resolves gateway.remote.password SecretInput refs when remote password is required",
      remoteAuth({ password: secretRef("REMOTE_REF_PASSWORD") }),
      { REMOTE_REF_PASSWORD: "resolved-remote-ref-password" },
      undefined,
      "resolved-remote-ref-password",
    ],
    [
      "does not resolve remote token ref when remote password already wins",
      remoteAuth({ token: secretRef("MISSING_REMOTE_TOKEN"), password: "remote-password" }),
      {},
      undefined,
      "remote-password",
    ],
    [
      "resolves remote token ref before unresolved remote password ref can block auth",
      remoteAuth({
        token: secretRef("REMOTE_REF_TOKEN"),
        password: secretRef("MISSING_REMOTE_PASSWORD"),
      }),
      { REMOTE_REF_TOKEN: "resolved-remote-ref-token" },
      "resolved-remote-ref-token",
      undefined,
    ],
    [
      "does not resolve remote password ref when remote token already wins",
      remoteAuth({ token: "remote-token", password: secretRef("MISSING_REMOTE_PASSWORD") }),
      {},
      "remote-token",
      undefined,
    ],
    [
      "resolves remote token refs on local-mode calls when fallback token can win",
      localAuth(
        {},
        {
          token: secretRef("LOCAL_FALLBACK_REMOTE_TOKEN"),
          password: secretRef("MISSING_REMOTE_PASSWORD"),
        },
      ),
      { LOCAL_FALLBACK_REMOTE_TOKEN: "resolved-local-fallback-remote-token" },
      "resolved-local-fallback-remote-token",
      undefined,
    ],
    [
      "does not resolve remote refs on non-remote gateway calls when auth mode is none",
      localAuth(
        { mode: "none" },
        {
          url: "wss://remote.example:18789",
          token: secretRef("MISSING_REMOTE_TOKEN"),
          password: secretRef("MISSING_REMOTE_PASSWORD"),
        },
      ),
      {},
      undefined,
      undefined,
    ],
  ])("%s", async (_name, gateway, env, token, password) => {
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    setEnvSecretGatewayConfig(gateway);
    await callGateway({ method: "health" });
    expect(lastClientOptions).toMatchObject({ token, password });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
