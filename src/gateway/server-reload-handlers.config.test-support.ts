import { vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import type { ConfigWriteNotification } from "../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayCronState } from "./server-cron.js";
import type {
  GatewayPluginReloadResult,
  GatewayHotReloadPublication,
  GatewayReloadHandlerParams,
  ManagedGatewayConfigReloaderHandle,
  ManagedGatewayConfigReloaderParams,
} from "./server-reload-contracts.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";

export type ReloadTestFactories = {
  createGatewayReloadHandlers: (
    params: Partial<GatewayReloadHandlerParams>,
  ) => ReturnType<typeof import("./server-reload-hot.js").createGatewayReloadHandlers>;
  startManagedGatewayConfigReloader: (
    params: Pick<
      ManagedGatewayConfigReloaderParams,
      "initialConfig" | "readSnapshot" | "subscribeToWrites"
    > &
      Partial<ManagedGatewayConfigReloaderParams>,
  ) => ManagedGatewayConfigReloaderHandle;
};

export function createHotReloadPublication(
  sourceConfig: OpenClawConfig = {},
  isCurrent = () => true,
): GatewayHotReloadPublication {
  return { sourceConfig, isCurrent, publish: async (commit) => await commit() };
}

type ConfigWriteListener = (event: ConfigWriteNotification) => void;
type ConfigWriteListenerRef = { current: ConfigWriteListener | null };

export function makePluginReloadResult(
  overrides: Partial<GatewayPluginReloadResult> = {},
): GatewayPluginReloadResult {
  return {
    runtime: { operationId: "test-reload", generation: 1, pluginIds: [] },
    activeChannels: new Set(),
    ...overrides,
  };
}

export function enableChannelReloadsForTest() {
  const previous = ["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"].map((key) => {
    const value = process.env[key];
    delete process.env[key];
    return { key, value };
  });
  return () => {
    for (const { key, value } of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export function createTestConfigRevisionProjector(): ManagedGatewayConfigReloaderParams["configRevisionProjector"] {
  return {
    projectRawHash: (hash) => hash,
    projectResolvedHash: (hash) => hash,
    hashResponseSessionBearer: () => "unused-test-scope",
  };
}

export function createCronRestartPlan(): GatewayReloadPlan {
  return createHotTailPlan({ changedPaths: ["cron"], hotReasons: ["cron"], restartCron: true });
}

export function createHotTailPlan(overrides: Partial<GatewayReloadPlan> = {}): GatewayReloadPlan {
  return {
    changedPaths: ["logging.level"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["logging.level"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
    ...overrides,
  };
}

export function createGatewayRestartPlan(changedPath = "gateway.port"): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: [changedPath],
    restartGateway: true,
    restartReasons: [changedPath],
    hotReasons: [],
  });
}

export function createPluginReloadPlan(): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: ["plugins.enabled"],
    hotReasons: ["plugins.enabled"],
    reloadPlugins: true,
  });
}

export function createValidConfigSnapshot(
  config: OpenClawConfig,
  hash: string,
): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(config),
    parsed: config,
    sourceConfig: config,
    resolved: config,
    valid: true,
    runtimeConfig: config,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    hash,
  };
}

export function createConfigWriteNotification(
  config: OpenClawConfig,
  persistedHash: string,
  revision: number,
  fingerprint: string,
  sourceFingerprint: string,
  overrides: Partial<ConfigWriteNotification> = {},
): ConfigWriteNotification {
  const sourceConfig = overrides.sourceConfig ?? config;
  const runtimeConfig = overrides.runtimeConfig ?? config;
  return {
    configPath: "/tmp/openclaw.json",
    sourceConfig: config,
    runtimeConfig: config,
    persistedHash,
    revision,
    fingerprint,
    sourceFingerprint,
    ...overrides,
    snapshot: overrides.snapshot ?? {
      ...createValidConfigSnapshot(sourceConfig, overrides.persistedHash ?? persistedHash),
      path: overrides.configPath ?? "/tmp/openclaw.json",
      runtimeConfig,
      config: runtimeConfig,
    },
  };
}

export function createConfigWriteListenerRef(): ConfigWriteListenerRef {
  return { current: null };
}

export function publishConfigWrite(listener: ConfigWriteListener, event: ConfigWriteNotification) {
  const application = createRuntimeConfigWriteApplication();
  listener(attachRuntimeConfigWriteApplication(event, application));
  return application.result;
}

export function captureConfigWriteListener(
  ref: ConfigWriteListenerRef,
  clearOnlyIfCurrent = true,
): ManagedGatewayConfigReloaderParams["subscribeToWrites"] {
  return (listener) => {
    ref.current = listener;
    return () => {
      if (!clearOnlyIfCurrent || ref.current === listener) {
        ref.current = null;
      }
    };
  };
}

export function createDirectConfigWriteFixture(initialConfig: OpenClawConfig) {
  let snapshot = createValidConfigSnapshot(initialConfig, "initial");
  const ref = createConfigWriteListenerRef();
  const subscribeToWrites: ManagedGatewayConfigReloaderParams["subscribeToWrites"] = (listener) =>
    captureConfigWriteListener(ref)((event) => {
      // Persist this write before notifying consumers; later writes replace the snapshot.
      snapshot = event.snapshot;
      listener(event);
    });
  return { ref, subscribeToWrites, readSnapshot: vi.fn(async () => snapshot) };
}

export function createDefaultGatewayReloadState(
  overrides: Partial<ReturnType<ManagedGatewayConfigReloaderParams["getState"]>> = {},
) {
  return {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
    cronState: createTestCronState(),
    ...overrides,
  };
}

export function createTestCronState(overrides: Partial<GatewayCronState> = {}): GatewayCronState {
  return {
    cron: { start: vi.fn(async () => {}), stop: vi.fn() } as never,
    storePath: "/tmp/cron.json",
    cronEnabled: false,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    ...overrides,
  };
}

export function createManagedReloadTestParams(
  params: Pick<
    ManagedGatewayConfigReloaderParams,
    | "initialConfig"
    | "scheduler"
    | "activateRuntimeSecrets"
    | "readSnapshot"
    | "subscribeToWrites"
    | "channelManager"
  > &
    Partial<ManagedGatewayConfigReloaderParams>,
): ManagedGatewayConfigReloaderParams {
  let state = createDefaultGatewayReloadState();
  const log = createInfoWarnErrorLogger();
  return {
    getPluginRegistry: requireActivePluginChannelRegistry,
    configRevisionProjector: createTestConfigRevisionProjector(),
    minimalTestGateway: false,
    initialCompareConfig: params.initialConfig,
    initialSnapshotRawHash: null,
    initialAuthoredConfig: {},
    initialSnapshotValid: true,
    initialSnapshotIssues: [],
    initialPluginInstallRecords: {},
    watchPath: "/tmp/openclaw.json",
    promoteSnapshot: async () => true,
    deps: {},
    broadcast: vi.fn(),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: async () => {
      throw new Error("Unexpected plugin reload");
    },
    logHooks: log,
    logChannels: log,
    logCron: log,
    logReload: log,
    cronReconciliation: { arm: () => ({ complete: async () => {} }), invalidate: vi.fn() },
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    prepareTerminalConfig: vi.fn(),
    reconcileRuntimePolicy: vi.fn(),
    commitRuntimePolicy: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    clients: [],
    ...params,
  };
}

export function createManagedReloadAuthFixture(params: {
  sharedAuthRotation?: boolean;
  resolvedProviderRotation?: "channel" | "agent";
}) {
  const providerConfig = (apiKey: string | { source: "env"; provider: string; id: string }) => ({
    models: {
      providers: { fixture: { baseUrl: "https://provider.example.test/v1", apiKey, models: [] } },
    },
  });
  const providerSource = params.resolvedProviderRotation
    ? {
        ...providerConfig({ source: "env", provider: "default", id: "FIXTURE_PROVIDER_KEY" }),
        agents: { entries: { main: { model: "fixture/first" }, other: {} } },
        channels: { slack: { streaming: { mode: "off" as const } } },
      }
    : {};
  const auth = params.sharedAuthRotation
    ? {
        mode: "token" as const,
        token: { source: "file" as const, provider: "default", id: "/token" },
      }
    : undefined;
  return { auth, providerConfig, providerSource };
}

export function createManagedRestartSequenceConfigs() {
  // This fixture owns auth inputs throughout asynchronous restart checks.
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  const secret = (id: string) => ({ source: "env" as const, provider: "default", id });
  const gatewayConfig = (port: number, token?: string, enabled = true): OpenClawConfig => ({
    gateway: {
      port,
      reload: {},
      terminal: { enabled },
      ...(token ? { auth: { mode: "token", token: secret(token) } } : {}),
    },
  });
  const deferredConfig = gatewayConfig(18790, "RESTART_A_TOKEN");
  const missingHotSecret = secret("MISSING_HOT_TOKEN");
  return {
    initialConfig: gatewayConfig(18789),
    deferredConfig,
    invalidConfig: gatewayConfig(18791, "MISSING_RESTART_TOKEN", false),
    invalidHotConfig: {
      ...deferredConfig,
      models: {
        providers: {
          test: {
            baseUrl: "https://example.com",
            apiKey: missingHotSecret,
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig,
    invalidNoopConfig: {
      ...deferredConfig,
      plugins: {
        entries: {
          brave: {
            config: { webSearch: { apiKey: missingHotSecret } },
          },
        },
      },
    } satisfies OpenClawConfig,
    replacementConfig: {
      gateway: { ...deferredConfig.gateway, bind: "lan" },
    } satisfies OpenClawConfig,
  };
}

export function createRecordedChannelHandlers(events: string[]) {
  return {
    stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
      events.push(`stop:${channel}:${accountId}`);
    }),
    start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
      events.push(`start:${channel}:${accountId}`);
      return new Map();
    }),
  };
}
