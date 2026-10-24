import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestGatewayRestartWithSignalAdmission } from "../infra/restart.js";
import {
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  captureConfigWriteListener,
  createConfigWriteNotification,
  createConfigWriteListenerRef,
  createManagedReloadTestParams,
  createValidConfigSnapshot,
  enableChannelReloadsForTest,
  makePluginReloadResult,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import type { startManagedGatewayConfigReloader as StartManagedGatewayConfigReloader } from "./server-reload-managed.js";
import {
  createTestRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

// Model preparation has its own lifecycle coverage; this regression needs the
// real reload transaction and async owners, not a cold model/plugin runtime.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: vi.fn(),
  beginPreparedModelRuntimePluginDrain: () => ({ pendingPublication: false, release: () => {} }),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
let restoreChannelReloadEnv: () => void;

beforeEach(() => {
  const watcher = installWatcherMock();
  onTestFinished(() => watcher.restore());
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  restoreChannelReloadEnv = enableChannelReloadsForTest();
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  restoreChannelReloadEnv();
});

it("starts replacement channels with the current Gateway owner after a writer settles", async () => {
  // Scheduler jobs retain the writer context even when the fake clock wakes elsewhere.
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const channelConfig = (name: string): OpenClawConfig => ({
    channels: { telegram: { accounts: { default: { name } } } },
  });
  const initialConfig = channelConfig("Before");
  const nextConfig = channelConfig("After");
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "telegram" }),
    reload: { configPrefixes: ["channels.telegram"] },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
  const writerContext = new AsyncLocalStorage<string>();
  const previousGateway = new LegacyPluginSdkResourceHost();
  const currentGateway = new LegacyPluginSdkResourceHost();
  const writerWork = new AsyncWorkScope();
  const writeListenerRef = createConfigWriteListenerRef();
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
      startupWork.run(() => {
        setRuntimeConfigSnapshot(initialConfig);
        return startReloader(
          createManagedReloadTestParams({
            scheduler,
            initialConfig,
            readSnapshot: async () => createValidConfigSnapshot(nextConfig, "profile-change"),
            subscribeToWrites: captureConfigWriteListener(writeListenerRef),
            startChannel,
            logReload: { info: vi.fn(), warn: vi.fn(), error: logReloadError },
            promoteSnapshot: vi.fn(async () => true) as never,
            reloadPlugins: vi.fn(async ({ prepareConfigEffects }) => {
              prepareConfigEffects({ pluginIds: new Set(), channels: new Set() }).retire();
              return makePluginReloadResult();
            }),
            channelManager: {
              pruneInactiveChannelAccountState: vi.fn(),
              releaseChannelRouteHandoffs: vi.fn(),
            } as never,
            activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) =>
              makePreparedSecretsSnapshot(config),
            ),
            requestRecoveryRestart: requestGatewayRestartWithSignalAdmission,
          }),
        );
      }),
    );
    await reloader.ready;
    await startupWork.drain();
    const listener = writeListenerRef.current;
    assert(listener, "Expected managed config write listener");
    const applied = writerContext.run("channel-turn", () =>
      writerWork.run(() =>
        publishConfigWrite(
          listener,
          createConfigWriteNotification(
            nextConfig,
            "profile-change",
            1,
            "runtime-profile-change",
            "source-profile-change",
          ),
        ),
      ),
    );
    await writerWork.drain();
    expect(startChannel).not.toHaveBeenCalled();
    await time.advanceBy(0);

    const status = await applied;
    expect(startChannel).toHaveBeenCalled();
    for (const [writer, host, signal] of channelContexts) {
      expect({ writer, signal }).toEqual({ writer: undefined, signal: undefined });
      expect(host === currentGateway, "reload must use the current Gateway SDK host").toBe(true);
    }
    expect(status, logReloadError.mock.calls.flat().join("\n")).toBe("applied");
  } finally {
    try {
      await reloader?.stop();
      await scheduler.stop();
    } finally {
      await Promise.all([previousGateway.close(), currentGateway.close()]);
    }
  }
});
