import { afterEach, assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { WizardSession } from "../wizard/session.js";
import {
  createPluginLifecycleLeaseTestClock,
  createReloadWarningObserver,
} from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./server-methods/setup-admission.js";
import type { ManagedGatewayConfigReloaderParams } from "./server-reload-contracts.js";
import {
  createConfigWriteNotification,
  createDirectConfigWriteFixture,
  createManagedReloadTestParams,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { createMockRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  reloadSessionMcpRuntimes: vi.fn(async () => {}),
}));
vi.mock("../agents/context.js", () => ({
  resetContextWindowCache: vi.fn(),
  refreshContextWindowCache: vi.fn(async () => {}),
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: vi.fn(),
  beginPreparedModelRuntimePluginDrain: () => ({ pendingPublication: false, release: () => {} }),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(() => Symbol("model-replacement")),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));
vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  clearLoadInstalledPluginIndexInstallRecordsCache: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
  loadInstalledPluginIndexInstallRecordsSync: vi.fn(() => ({})),
}));
vi.mock("../logging/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/logger.js")>()),
  applyLoggingConfig: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  const watcher = installWatcherMock();
  onTestFinished(() => watcher.restore());
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-wizard-lease-"));
  vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
  vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function createReloadFixture(
  reloadPlugins: ManagedGatewayConfigReloaderParams["reloadPlugins"],
) {
  const initialConfig = {
    gateway: { reload: {} },
    channels: { whatsapp: { enabled: true, selfChatMode: false } },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(initialConfig);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "whatsapp" }),
          reload: { configPrefixes: ["channels.whatsapp"], noopPrefixes: [] },
        },
      },
    ]),
  );
  const writer = createDirectConfigWriteFixture(initialConfig);
  const warnings = createReloadWarningObserver();
  const logReload = createInfoWarnErrorLogger();
  logReload.warn.mockImplementation(warnings.observe);
  const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
  const clock = createGatewaySchedulerClock(Date.now());
  const reloader = startManagedGatewayConfigReloader(
    createManagedReloadTestParams({
      scheduler: createTestGatewayScheduler(clock.clock),
      initialConfig,
      initialAuthoredConfig: initialConfig,
      readSnapshot: writer.readSnapshot,
      subscribeToWrites: writer.subscribeToWrites,
      startChannel: channels.start,
      stopChannel: channels.stop,
      reloadPlugins,
      logReload,
      channelManager: {
        pruneInactiveChannelAccountState: vi.fn(),
        releaseChannelRouteHandoffs: vi.fn(),
      } as never,
      activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
      requestRecoveryRestart: vi.fn(() => ({ status: "emitted" as const })),
    }),
  );
  await reloader.ready;
  const leaseClock = createPluginLifecycleLeaseTestClock();
  return {
    initialConfig,
    channels,
    warnings,
    logReload,
    reloader,
    leaseClock,
    wakeReload() {
      expect(clock.armedAtMs).not.toBeNull();
      clock.setTime(Date.now());
      return Promise.resolve(clock.wake());
    },
    submit(config: OpenClawConfig, hash: string, revision: number) {
      assert(writer.ref.current);
      return publishConfigWrite(
        writer.ref.current,
        createConfigWriteNotification(config, hash, revision, "runtime", "source"),
      );
    },
  };
}

it.each(["committed mixed", "uncommitted channel-only"] as const)(
  "finishes %s reload and applies the wizard's successor config without a drain timeout",
  async (kind) => {
    const mixed = kind === "committed mixed";
    const pluginCommitted = createDeferred();
    const releasePlugin = createDeferred();
    const reloadPlugins = vi.fn<ManagedGatewayConfigReloaderParams["reloadPlugins"]>(
      async (params) => {
        params
          .prepareConfigEffects({ pluginIds: new Set(["fixture"]), channels: new Set() })
          .retire();
        await params.commitRuntime();
        pluginCommitted.resolve();
        await releasePlugin.promise;
        return {
          runtime: { operationId: "mixed-reload", generation: 1, pluginIds: ["fixture"] },
          activeChannels: new Set(["whatsapp"]),
        };
      },
    );
    const fixture = await createReloadFixture(reloadPlugins);
    const nextConfig: OpenClawConfig = {
      ...fixture.initialConfig,
      channels: { whatsapp: { enabled: true, selfChatMode: true } },
      ...(mixed ? { plugins: { entries: { fixture: { enabled: true } } } } : {}),
    };
    const successorConfig: OpenClawConfig = { ...nextConfig, logging: { level: "debug" } };
    const saveStarted = createDeferred();
    let saved: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
    let wizard: WizardSession | undefined;
    let firstWrite: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
    let firstReload: Promise<void> | undefined;
    const createWizard = () =>
      new WizardSession(async (prompter, signal, session) => {
        await prompter.confirm({ message: "Save the next channel?" });
        saveStarted.resolve();
        await withPluginLifecycleLease({ signal }, async (lease) => {
          lease.assertOwned();
          session.lockCancellation();
          saved = fixture.submit(successorConfig, "wizard-successor", 2);
        });
      });
    try {
      if (mixed) {
        firstWrite = fixture.submit(nextConfig, "mixed-plugin-channel", 1);
        firstReload = fixture.wakeReload();
        await fixture.leaseClock.waitFor(pluginCommitted.promise);
        expect(fixture.reloader.getCommittedRuntimeConfig?.()).toMatchObject(nextConfig);
      }
      wizard = await runWithGatewayIndependentRootWorkAdmission(
        () => createAdmittedWizardSession(createWizard, false),
        "rpc:wizard.start",
      );
      assert(wizard);
      const prompt = await wizard.next();
      assert(prompt.step);
      const deferred = fixture.warnings.next("deferring until");
      if (mixed) {
        releasePlugin.resolve();
      } else {
        firstWrite = fixture.submit(nextConfig, "channel-only", 1);
        firstReload = fixture.wakeReload();
      }
      await fixture.leaseClock.waitFor(deferred);
      expect(fixture.channels.stop).not.toHaveBeenCalled();
      expect(fixture.reloader.getDeferredChannelReloads?.()).toEqual([
        { channel: "whatsapp", publicationPending: !mixed },
      ]);

      const saveStartedAt = Date.now();
      await wizard.answer(prompt.step.id, true);
      await saveStarted.promise;
      const activeWizard = wizard;
      const next = runWithGatewayIndependentRootWorkAdmission(
        () => activeWizard.next(),
        "ws:wizard.next",
      );
      await vi.advanceTimersByTimeAsync(500);
      // Fail before awaiting the blocked save, so the unfixed deadlock cannot consume 300 seconds.
      expect(fixture.logReload.warn).toHaveBeenCalledWith(
        expect.stringMatching(/channel reload proceeding .*waiting for the plugin lifecycle lease/),
      );
      // Settle the holder's worker cleanup before advancing the waiter's fake retry clock.
      await firstReload;
      const result = await fixture.leaseClock.waitFor(next);
      await whenAdmittedWizardSessionSettled(wizard);
      expect(result).toMatchObject({ done: true, status: "done", error: undefined });
      expect(Date.now() - saveStartedAt).toBeLessThan(10_000);
      expect(saved).toBeDefined();
      await expect(firstWrite).resolves.toBe("applied");
      expect(fixture.channels.stop).toHaveBeenCalledOnce();
      expect(fixture.channels.start).toHaveBeenCalledOnce();
      await fixture.leaseClock.waitFor(fixture.wakeReload());
      await expect(saved).resolves.toBe("applied");
      expect(fixture.reloader.getCommittedRuntimeConfig?.()).toMatchObject(successorConfig);
      expect(reloadPlugins).toHaveBeenCalledTimes(mixed ? 1 : 0);
      expect(fixture.logReload.error).not.toHaveBeenCalled();
      expect(fixture.logReload.warn).not.toHaveBeenCalledWith(expect.stringContaining("timeout"));
    } finally {
      releasePlugin.resolve();
      wizard?.close(new Error("test complete"));
      const stopping = fixture.reloader.stop();
      await vi.advanceTimersByTimeAsync(500);
      await fixture.leaseClock.waitFor(stopping);
      if (wizard) {
        await whenAdmittedWizardSessionSettled(wizard);
      }
      await firstWrite;
      await saved;
    }
  },
);
