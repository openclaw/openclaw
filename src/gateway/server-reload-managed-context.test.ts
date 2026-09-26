import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { ConfigWriteNotification } from "../config/config.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestGatewayRestartWithSignalAdmission } from "../infra/restart.js";
import {
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  captureActivePluginRegistrySnapshot,
  requireActivePluginChannelRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayPluginReloadResult } from "./server-reload-contracts.js";
import {
  createConfigWriteNotification,
  createValidConfigSnapshot,
} from "./server-reload-handlers.config.test-support.js";
import type { startManagedGatewayConfigReloader as StartManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

// Model preparation has its own lifecycle coverage; this regression needs the
// real reload transaction and async owners, not a cold model/plugin runtime.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: vi.fn(),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

type ManagedReloaderParams = Parameters<typeof StartManagedGatewayConfigReloader>[0];
type ConfigWriteListener = (event: ConfigWriteNotification) => void;
type ConfigWriteListenerRef = { current: ConfigWriteListener | null };
type ManagedReloaderTestParams = Pick<
  ManagedReloaderParams,
  "initialConfig" | "readSnapshot" | "subscribeToWrites"
> &
  Partial<ManagedReloaderParams>;

let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
let skipChannels: string | undefined;
let skipProviders: string | undefined;

beforeEach(() => {
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  skipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
  skipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  if (skipChannels === undefined) {
    delete process.env.OPENCLAW_SKIP_CHANNELS;
  } else {
    process.env.OPENCLAW_SKIP_CHANNELS = skipChannels;
  }
  if (skipProviders === undefined) {
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  } else {
    process.env.OPENCLAW_SKIP_PROVIDERS = skipProviders;
  }
});

function createTestCronReconciliation() {
  const complete = vi.fn<() => Promise<void>>(async () => {});
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete })),
    complete,
    invalidate: vi.fn(),
  };
}

function createTestCronState(): GatewayCronState {
  return {
    cron: { start: vi.fn(async () => {}), stop: vi.fn() } as never,
    storePath: "/tmp/cron.json",
    cronEnabled: false,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn(async () => "converged" as const),
  };
}

function makePreparedSecretsSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
    authStores: prepareRuntimeAuthProfileStoreSnapshots([]),
  };
}

function startManagedGatewayConfigReloader(
  startManagedGatewayConfigReloaderImpl: typeof StartManagedGatewayConfigReloader,
  params: ManagedReloaderTestParams,
) {
  let state: ReturnType<ManagedReloaderParams["getState"]> = {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
    cronState: createTestCronState(),
  };
  return startManagedGatewayConfigReloaderImpl({
    scheduler: createTestGatewayScheduler(),
    getPluginRegistry: requireActivePluginChannelRegistry,
    minimalTestGateway: false,
    initialPluginInstallRecords: {},
    initialCompareConfig: params.initialConfig,
    watchPath: "/tmp/openclaw.json",
    promoteSnapshot: vi.fn(async () => true) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async ({ prepareConfigEffects }) => {
      prepareConfigEffects({ pluginIds: new Set(), channels: new Set() });
      return {
        runtime: { operationId: "test-reload", generation: 1, pluginIds: [] },
        activeChannels: new Set(),
      } satisfies GatewayPluginReloadResult;
    }),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channelManager: {
      pruneInactiveChannelAccountState: vi.fn(),
      releaseChannelRouteHandoffs: vi.fn(),
    } as never,
    activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) =>
      makePreparedSecretsSnapshot(config),
    ),
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    clients: [],
    reconcileRuntimePolicy: vi.fn(),
    commitRuntimePolicy: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    ...params,
    configRevisionProjector: params.configRevisionProjector ?? {
      projectRawHash: (hash) => hash,
      projectResolvedHash: (hash) => hash,
    },
    initialSnapshotRawHash: params.initialSnapshotRawHash ?? null,
    initialAuthoredConfig: params.initialAuthoredConfig ?? {},
    initialSnapshotValid: params.initialSnapshotValid ?? true,
    initialSnapshotIssues: params.initialSnapshotIssues ?? [],
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    prepareTerminalConfig: params.prepareTerminalConfig ?? vi.fn(),
    requestRecoveryRestart:
      params.requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
  });
}

function captureConfigWriteListener(ref: ConfigWriteListenerRef) {
  return (listener: ConfigWriteListener) => {
    ref.current = listener;
    return () => {
      if (ref.current === listener) {
        ref.current = null;
      }
    };
  };
}

describe("managed gateway reload context", () => {
  it("starts replacement channels with the current Gateway owner after a writer settles", async () => {
    // Real timers retain the writer's async context; advancing fake timers
    // outside it would hide the context leak this regression checks.
    const initialConfig: OpenClawConfig = {
      channels: { telegram: { accounts: { default: { name: "Before" } } } },
    };
    const nextConfig: OpenClawConfig = {
      channels: { telegram: { accounts: { default: { name: "After" } } } },
    };
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "telegram" }),
      reload: { configPrefixes: ["channels.telegram"] },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    const writerContext = new AsyncLocalStorage<string>();
    const previousGateway = new LegacyPluginSdkResourceHost();
    const currentGateway = new LegacyPluginSdkResourceHost();
    const writerWork = new AsyncWorkScope();
    const writeListenerRef: ConfigWriteListenerRef = { current: null };
    const channelContexts: Array<
      [string | undefined, LegacyPluginSdkResourceHost, AbortSignal | undefined]
    > = [];
    const logReloadError = vi.fn<(message: string) => void>();
    const startChannel = vi.fn(async () => {
      const host = getLegacyPluginSdkResourceHost();
      channelContexts.push([writerContext.getStore(), host, getAsyncWorkSignal()]);
      return host.invoke(() => new Map());
    });
    const startupWork = new AsyncWorkScope();
    let reloader: ReturnType<typeof StartManagedGatewayConfigReloader> | undefined;
    try {
      // Production lazily imports this module inside the first Gateway's SDK host.
      // Keep that module instance when the replacement Gateway takes ownership.
      const { startManagedGatewayConfigReloader: startReloader } = await previousGateway.run(
        () => import("./server-reload-managed.js"),
      );
      await previousGateway.close();
      reloader = currentGateway.run(() =>
        startupWork.run(() =>
          startManagedGatewayConfigReloader(startReloader, {
            initialConfig,
            readSnapshot: async () => createValidConfigSnapshot(nextConfig, "profile-change"),
            subscribeToWrites: captureConfigWriteListener(writeListenerRef),
            startChannel,
            logReload: { info: vi.fn(), warn: vi.fn(), error: logReloadError },
          }),
        ),
      );
      await reloader.ready;
      await startupWork.drain();
      const application = createRuntimeConfigWriteApplication();
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected managed config write listener");
      }
      writerContext.run("channel-turn", () =>
        writerWork.run(() => {
          listener(
            attachRuntimeConfigWriteApplication(
              createConfigWriteNotification(
                nextConfig,
                "profile-change",
                1,
                "runtime-profile-change",
                "source-profile-change",
              ),
              application,
            ),
          );
        }),
      );
      await writerWork.drain();

      const status = await application.result;
      expect(startChannel).toHaveBeenCalled();
      for (const [writer, host, signal] of channelContexts) {
        expect(writer).toBeUndefined();
        expect(host === currentGateway, "reload must use the current Gateway SDK host").toBe(true);
        expect(signal).toBeUndefined();
      }
      expect(status, logReloadError.mock.calls.flat().join("\n")).toBe("applied");
    } finally {
      try {
        await reloader?.stop();
      } finally {
        await Promise.all([previousGateway.close(), currentGateway.close()]);
      }
    }
  });
});
