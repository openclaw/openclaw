import { expect, type Mock, vi } from "vitest";
import type { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import type { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import { VERSION } from "../version.js";
import type { configureNodeHost, NodeHostConfig } from "./config.js";

const mocks = vi.hoisted(() => {
  const initialState = () => ({
    capturedGatewayClientOptions: [] as GatewayClientOptions[],
    capturedConfiguredGatewayConfigs: [] as Array<{ contextPath?: string }>,
    capturedGatewayClients: [] as Array<{
      request: Mock<(method: string, params?: unknown) => Promise<unknown>>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      stopAndWait: ReturnType<typeof vi.fn<() => Promise<void>>>;
      updateNodeManifest: ReturnType<typeof vi.fn>;
    }>,
    mcpDescriptors: [] as Array<Record<string, unknown>>,
    mcpDescriptorsChanged: undefined as (() => void) | undefined,
    nodePluginTools: [] as Array<Record<string, unknown>>,
    nodeSkillDescriptors: [] as Array<Record<string, unknown>>,
    useFakeRuntime: false,
    useRealGatewayClient: false,
    fakeRuntimeWorkerHosting: false,
    fakeRuntimeWorkerHostingDisabledReason: undefined as string | undefined,
    runnerCapacityChanged: undefined as
      | ((capacity: { total: number; available: number }) => void)
      | undefined,
    nodeHostCommands: [] as string[],
    nodeHostCaps: [] as string[],
    availabilityOnWatch: undefined as { caps: string[]; commands: string[] } | undefined,
    availabilityChanged: undefined as (() => void) | undefined,
    resolvedExecutables: new Map<string, string>(),
  });
  return {
    ...initialState(),
    resetState(): void {
      Object.assign(mocks, initialState());
    },
    closeMcpManager: vi.fn(async () => undefined),
    loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
    loadDeviceAuthTokenReadOnly: vi.fn<typeof loadDeviceAuthTokenReadOnly>(async () => null),
    loadDeviceIdentityIfPresent: vi.fn(
      async () => null as { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null,
    ),
    configureNodeHost: vi.fn(async (params: Parameters<typeof configureNodeHost>[0]) => {
      mocks.capturedConfiguredGatewayConfigs.push(params.gateway);
      return {
        version: 1 as const,
        nodeId: params.nodeId?.trim() || "node-test",
        displayName: params.displayName?.trim() || params.fallbackDisplayName,
        gateway: params.gateway,
      };
    }),
    getRuntimeConfig: vi.fn<() => unknown>(() => ({ gateway: { handshakeTimeoutMs: 1_000 } })),
    startGatewayClientWhenEventLoopReady: vi.fn<typeof startGatewayClientWhenEventLoopReady>(
      async () => ({
        ready: false,
        aborted: false,
        elapsedMs: 0,
        maxDriftMs: 0,
        checks: 0,
      }),
    ),
    resolveGatewayCredentialsWithSecretInputs: vi.fn(async (_params: { config: unknown }) => ({})),
    activeRuntime: {
      invoke: vi.fn(async () => {}),
      handleInput: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(async () => {}),
      tryPauseForUpdate: vi.fn(async () => true),
      resumeAfterUpdate: vi.fn(),
      updateGatewayConnection: vi.fn(),
      close: vi.fn(async () => {}),
    },
  };
});

// mock-isolation: Node-host fixtures control connection config without reading operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  captureRuntimeConfigAsyncReader: () => async () => mocks.getRuntimeConfig(),
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/client.js")>();
  return {
    ...actual,
    GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
      if (mocks.useRealGatewayClient) {
        return new actual.GatewayClient(opts);
      }
      const client = {
        request: vi.fn(async () => ({})),
        start: vi.fn(),
        stop: vi.fn(),
        stopAndWait: vi.fn(async () => {}),
        updateNodeManifest: vi.fn(),
      };
      mocks.capturedGatewayClientOptions.push(opts);
      mocks.capturedGatewayClients.push(client);
      return client;
    },
  };
});

vi.mock("../gateway/credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: mocks.resolveGatewayCredentialsWithSecretInputs,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-auth-store.js")>()),
  loadDeviceAuthTokenReadOnly: mocks.loadDeviceAuthTokenReadOnly,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadDeviceIdentityIfPresentAsync: mocks.loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentityAsync: vi.fn(async () => ({
    deviceId: "device-test",
    publicKeyPem: "public-key-test",
    privateKeyPem: "private-key-test",
  })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-node"),
}));

vi.mock("../infra/machine-model.js", () => ({
  resolveMachineModelIdentifier: vi.fn(() => "TestMachine1,1"),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: vi.fn((bin: string) => mocks.resolvedExecutables.get(bin) ?? null),
}));

// mock-isolation: Keep host PATH mutation outside the isolated runner fixture.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));

vi.mock("./config.js", () => ({
  configureNodeHost: mocks.configureNodeHost,
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

// mock-isolation: Synthetic node-host capabilities avoid real plugin discovery and lifecycle effects.
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  notifyRegisteredNodeHostCommandDisconnect: vi.fn(async () => {}),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    commands: [...mocks.nodeHostCommands],
    caps: [...mocks.nodeHostCaps],
    nodePluginTools: [...mocks.nodePluginTools],
  })),
  watchRegisteredNodeHostCommandAvailability: vi.fn((_context: unknown, onChange: () => void) => {
    mocks.availabilityChanged = onChange;
    if (mocks.availabilityOnWatch) {
      mocks.nodeHostCaps = [...mocks.availabilityOnWatch.caps];
      mocks.nodeHostCommands = [...mocks.availabilityOnWatch.commands];
    }
    return () => {
      mocks.availabilityChanged = undefined;
    };
  }),
}));

// mock-isolation: runner fixtures own MCP descriptors and shutdown without starting live clients.
vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(
    async (_servers: unknown, deps?: { onDescriptorsChanged?: () => void }) => {
      mocks.mcpDescriptorsChanged = deps?.onDescriptorsChanged;
      return {
        descriptors: mocks.mcpDescriptors,
        callMcpTool: vi.fn(),
        close: mocks.closeMcpManager,
      };
    },
  ),
}));

// mock-isolation: runner fixtures supply their own node skill inventory.
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn(() => mocks.nodeSkillDescriptors) }));
// mock-isolation: runner startup tests bypass real state migration and database admission.
vi.mock("./startup-state-readiness.js", () => ({ ensureNodeHostStateReady: () => {} }));

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    prepareNodeHostRuntime: async (
      ...args: Parameters<typeof actual.prepareNodeHostRuntime>
    ): ReturnType<typeof actual.prepareNodeHostRuntime> => {
      if (!mocks.useFakeRuntime) {
        return await actual.prepareNodeHostRuntime(...args);
      }
      return {
        manifest: { caps: [], commands: [], pathEnv: process.env.PATH ?? "" },
        workerHostingEnabled: mocks.fakeRuntimeWorkerHosting,
        preparedWorkspacesEnabled: false,
        nativeInferenceEnabled: false,
        workerHostingDisabledReason: mocks.fakeRuntimeWorkerHostingDisabledReason,
        initialInventory: { skills: [], pluginTools: [] },
        start: (params) => {
          mocks.runnerCapacityChanged = params.onRunnerCapacityChanged;
          return mocks.activeRuntime;
        },
      };
    },
  };
});

// Load after mock registration and retain local bindings for Vitest's export transform.
const { loadResumableNodeHostGateway, runNodeHost } = await import("./runner.js");
const { startNodeHostMcpManager } = await import("./mcp.js");

export function lastCapturedOptions(): GatewayClientOptions | undefined {
  return mocks.capturedGatewayClientOptions.at(-1);
}

export function receiveHello(
  options = lastCapturedOptions(),
  protocol = 4,
  capabilities: string[] = [],
) {
  options?.onHelloOk?.({
    type: "hello-ok",
    protocol,
    server: { version: VERSION, connId: "node-test" },
    features: { methods: [], events: [], capabilities },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "node", scopes: [] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
  });
}

export async function expectStartupTimeout(
  options: Partial<Parameters<typeof runNodeHost>[0]> = {},
) {
  await expect(
    runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789, ...options }),
  ).rejects.toThrow("event loop readiness timeout");
}

export const expectCalls = (mock: unknown, count = 1) =>
  vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));

export function resetRunnerTestState() {
  mocks.resetState();
  mocks.nodePluginTools = [
    {
      pluginId: "test-plugin",
      name: "remote_echo",
      description: "Echo from node host",
      command: "test.echo",
      parameters: { type: "object", properties: {} },
    },
  ];
  vi.clearAllMocks();
  mocks.loadNodeHostConfig.mockReset().mockResolvedValue(null);
  mocks.loadDeviceAuthTokenReadOnly.mockReset().mockResolvedValue(null);
  mocks.loadDeviceIdentityIfPresent.mockReset().mockResolvedValue(null);
  mocks.getRuntimeConfig.mockReturnValue({ gateway: { handshakeTimeoutMs: 1_000 } });
}

export { loadResumableNodeHostGateway, mocks, runNodeHost, startNodeHostMcpManager };

export function readyNodeHost() {
  mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
    ready: true,
    aborted: false,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 1,
  });
}

export async function withReadyNodeHost(
  runTest: (host: {
    running: Promise<void>;
    stop: () => (() => void) | undefined;
    client: (typeof mocks.capturedGatewayClients)[number];
    options: GatewayClientOptions;
  }) => Promise<void>,
  options: Partial<Parameters<typeof runNodeHost>[0]> = {},
  beforeStop?: () => void,
) {
  readyNodeHost();
  const on = vi.spyOn(process, "on");
  const previousExitCode = process.exitCode;
  const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789, ...options });
  const stop = () => {
    const listener = on.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    listener?.("SIGTERM");
    return listener;
  };
  try {
    await vi.waitFor(() => expect(on).toHaveBeenCalledWith("SIGTERM", expect.any(Function)));
    await runTest({
      running,
      stop,
      client: mocks.capturedGatewayClients[0]!,
      options: lastCapturedOptions()!,
    });
  } finally {
    beforeStop?.();
    stop();
    try {
      await running;
    } finally {
      for (const [event, listener] of on.mock.calls) {
        if (event === "SIGINT" || event === "SIGTERM") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      on.mockRestore();
    }
  }
}
