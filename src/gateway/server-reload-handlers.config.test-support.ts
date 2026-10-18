import { vi } from "vitest";
import type { ConfigWriteNotification } from "../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayCronState } from "./server-cron.js";
import type {
  GatewayPluginReloadResult,
  ManagedGatewayConfigReloaderParams,
} from "./server-reload-contracts.js";

export function createMonitorPublicationFailure() {
  const database = openOpenClawStateDatabase();
  return {
    install() {
      // Persistent fault injection reaches cron workers; managed admission services
      // outstanding grants instead of blocking the host needed to finish their write.
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          db.exec(`CREATE TRIGGER monitor_publication_failure BEFORE UPDATE ON cron_jobs
          WHEN json_extract(NEW.job_json, '$.agentId') = 'second'
            AND json_extract(NEW.job_json, '$.schedule.everyMs') = 7200000
          BEGIN SELECT RAISE(FAIL, 'monitor write failed'); END`),
        { database },
      );
    },
    remove() {
      runOpenClawStateWriteTransaction(
        ({ db }) => db.exec("DROP TRIGGER monitor_publication_failure"),
        { database },
      );
    },
    dispose() {
      runOpenClawStateWriteTransaction(
        ({ db }) => db.exec("DROP TRIGGER IF EXISTS monitor_publication_failure"),
        { database },
      );
    },
  };
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
  const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
  const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  return () => {
    if (previousSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
    }
    if (previousSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
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
  return createHotTailPlan({
    changedPaths: ["cron"],
    hotReasons: ["cron"],
    restartCron: true,
  });
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
    writtenAtMs: Date.now(),
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
    reconcileSystemJobs: vi.fn<GatewayCronState["reconcileSystemJobs"]>(async () => "converged"),
    ...overrides,
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
  const initialConfig = {
    gateway: {
      port: 18789,
      reload: {},
      terminal: { enabled: true },
    },
  } as OpenClawConfig;
  const deferredConfig = {
    gateway: {
      port: 18790,
      reload: {},
      terminal: { enabled: true },
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "RESTART_A_TOKEN",
        },
      },
    },
  } as OpenClawConfig;
  const invalidConfig = {
    gateway: {
      ...deferredConfig.gateway,
      port: 18791,
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "MISSING_RESTART_TOKEN",
        },
      },
      terminal: { enabled: false },
    },
  } as OpenClawConfig;
  const missingHotSecret = {
    source: "env" as const,
    provider: "default",
    id: "MISSING_HOT_TOKEN",
  };
  const invalidHotConfig = {
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
  } as OpenClawConfig;
  const invalidNoopConfig = {
    ...deferredConfig,
    plugins: {
      entries: {
        brave: {
          config: { webSearch: { apiKey: missingHotSecret } },
        },
      },
    },
  } as OpenClawConfig;
  const replacementConfig = {
    gateway: {
      ...deferredConfig.gateway,
      bind: "lan",
    },
  } as OpenClawConfig;
  return {
    initialConfig,
    deferredConfig,
    invalidConfig,
    invalidHotConfig,
    invalidNoopConfig,
    replacementConfig,
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
