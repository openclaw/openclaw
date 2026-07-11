/**
 * Gateway config reload handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import type { ConfigWriteNotification } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  consumeGatewaySigusr1RestartIntent,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  requestGatewayRestartWithSignalAdmission,
  setGatewaySigusr1RestartPolicy,
  testing as restartTesting,
} from "../infra/restart.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
} from "../plugins/runtime.js";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import {
  abortPendingChannelReloads,
  createGatewayReloadHandlers as createGatewayReloadHandlersImpl,
  startManagedGatewayConfigReloader as startManagedGatewayConfigReloaderImpl,
} from "./server-reload-handlers.js";

type ReloadHandlerParams = Parameters<typeof createGatewayReloadHandlersImpl>[0];
type ManagedReloaderParams = Parameters<typeof startManagedGatewayConfigReloaderImpl>[0];

function createGatewayReloadHandlers(
  params: Omit<ReloadHandlerParams, "cronReconciliation" | "requestRecoveryRestart"> & {
    cronReconciliation?: ReloadHandlerParams["cronReconciliation"];
    requestRecoveryRestart?: NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> | null;
  },
) {
  const { requestRecoveryRestart, ...handlerParams } = params;
  return createGatewayReloadHandlersImpl({
    ...handlerParams,
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    ...(requestRecoveryRestart === null
      ? {}
      : {
          requestRecoveryRestart:
            requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
        }),
  });
}

function startManagedGatewayConfigReloader(
  params: Omit<ManagedReloaderParams, "cronReconciliation"> & {
    cronReconciliation?: ManagedReloaderParams["cronReconciliation"];
  },
) {
  return startManagedGatewayConfigReloaderImpl({
    ...params,
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    requestRecoveryRestart:
      params.requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
  });
}

type GmailWatcherRestartParams = {
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  onSkipped?: () => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
};

type StartGmailWatcherWithLogs = (params: GmailWatcherRestartParams) => Promise<void>;
type StopGmailWatcher = () => Promise<void>;

const hoisted = vi.hoisted(() => ({
  startGmailWatcherWithLogs: vi.fn<StartGmailWatcherWithLogs>(async () => {}),
  stopGmailWatcher: vi.fn<StopGmailWatcher>(async () => {}),
  activeTaskCount: { value: 0 },
  activeTaskBlockers: [] as Array<{
    taskId: string;
    status: "queued" | "running";
    runtime: "subagent" | "acp" | "cli" | "cron";
    runId?: string;
    label?: string;
    title?: string;
  }>,
  activeEmbeddedRunCount: { value: 0 },
  activeEmbeddedRunSessionIds: [] as string[],
  activeEmbeddedRunSessionKeys: [] as string[],
  markRestartAbortedMainSessions: vi.fn(async (_params: unknown) => ({ marked: 1, skipped: 0 })),
  runtimeConfig: { value: { session: { store: "/tmp/active-sessions.json" } } as OpenClawConfig },
  reloadEvents: [] as string[],
  loadModelCatalog: vi.fn(async (_params: { config: OpenClawConfig }) => []),
  resetModelCatalogCache: vi.fn(() => {}),
  refreshContextWindowCache: vi.fn(async (_cfg: OpenClawConfig) => {}),
  clearCurrentProviderAuthState: vi.fn(() => {}),
  warmCurrentProviderAuthStateOffMainThread: vi.fn(async (_cfg: OpenClawConfig) => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  buildGatewayCronService: vi.fn(() => ({
    cron: { start: vi.fn(async () => {}), stop: vi.fn() },
    storePath: "/tmp/rebuilt-cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    stopExitWatchers: vi.fn(),
  })),
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../tasks/task-registry.maintenance.js", async () => {
  const actual = await vi.importActual<typeof import("../tasks/task-registry.maintenance.js")>(
    "../tasks/task-registry.maintenance.js",
  );
  return {
    ...actual,
    getInspectableActiveTaskRestartBlockers: () => hoisted.activeTaskBlockers,
    getInspectableTaskRegistrySummary: () => ({
      total: hoisted.activeTaskCount.value,
      active: hoisted.activeTaskCount.value,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: hoisted.activeTaskCount.value,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: hoisted.activeTaskCount.value,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    }),
  };
});

vi.mock("../agents/embedded-agent-runner/run-state.js", () => ({
  getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
  listActiveEmbeddedRunSessionIds: () => hoisted.activeEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys: () => hoisted.activeEmbeddedRunSessionKeys,
}));

vi.mock("../agents/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: hoisted.markRestartAbortedMainSessions,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => hoisted.runtimeConfig.value,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: (params: { config: OpenClawConfig }) => {
    hoisted.reloadEvents.push("load-model-catalog");
    return hoisted.loadModelCatalog(params);
  },
  resetModelCatalogCache: () => {
    hoisted.reloadEvents.push("reset-model-catalog");
    hoisted.resetModelCatalogCache();
  },
}));

vi.mock("../agents/context.js", () => ({
  refreshContextWindowCache: async (cfg: OpenClawConfig) => {
    hoisted.reloadEvents.push("refresh-context-window");
    await hoisted.refreshContextWindowCache(cfg);
  },
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  clearCurrentProviderAuthState: () => {
    hoisted.reloadEvents.push("clear-provider-auth");
    hoisted.clearCurrentProviderAuthState();
  },
  warmCurrentProviderAuthStateOffMainThread: async (cfg: OpenClawConfig) => {
    hoisted.reloadEvents.push("warm-provider-auth");
    await hoisted.warmCurrentProviderAuthStateOffMainThread(cfg);
  },
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  disposeAllSessionMcpRuntimes: hoisted.disposeAllSessionMcpRuntimes,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
  loadInstalledPluginIndexInstallRecordsSync: vi.fn(() => ({})),
}));

vi.mock("./server-cron.js", async () => {
  const actual = await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
  return {
    ...actual,
    buildGatewayCronService: hoisted.buildGatewayCronService,
  };
});

function createTestCronReconciliation() {
  const complete = vi.fn<() => Promise<void>>(async () => {});
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete })),
    complete,
    invalidate: vi.fn(),
  };
}

function createCronRestartPlan(): GatewayReloadPlan {
  return {
    changedPaths: ["cron"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["cron"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: true,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
  };
}

function createReloadHandlersForTest(
  logReload = { info: vi.fn(), warn: vi.fn() },
  channels?: {
    start: (channel: ChannelKind) => Promise<void>;
    stop: (channel: ChannelKind) => Promise<void>;
  },
  reloadPlugins?: Parameters<typeof createGatewayReloadHandlers>[0]["reloadPlugins"],
  stopPostReadySidecars = vi.fn(),
  recovery: boolean | NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> = true,
) {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const stopExitWatchers = vi.fn();
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  let state: Parameters<ReloadHandlerParams["setState"]>[0] = {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: heartbeatRunner as never,
    cronState: {
      cron,
      storePath: "/tmp/cron.json",
      cronEnabled: false,
      stopExitWatchers,
    } as never,
    channelHealthMonitor: null,
  };
  const setState = vi.fn((nextState: typeof state) => {
    state = nextState;
  });
  const cronReconciliation = createTestCronReconciliation();
  const logCron = { error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState,
    startChannel: channels?.start ?? vi.fn(async () => {}),
    stopChannel: channels?.stop ?? vi.fn(async () => {}),
    stopPostReadySidecars,
    reloadPlugins:
      reloadPlugins ??
      vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron,
    logReload,
    cronReconciliation,
    requestRecoveryRestart:
      typeof recovery === "function"
        ? recovery
        : recovery
          ? requestGatewayRestartWithSignalAdmission
          : null,
    createHealthMonitor: () => null,
  });
  return {
    ...handlers,
    cron,
    cronReconciliation,
    heartbeatRunner,
    logCron,
    setState,
    stopExitWatchers,
  };
}

async function withGatewayRestartSignal(
  run: (signalSpy: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  restartTesting.resetSigusr1State();
  resetGatewayWorkAdmission();
  const signalSpy = vi.fn();
  process.once("SIGUSR1", signalSpy);
  try {
    await run(signalSpy);
  } finally {
    process.removeListener("SIGUSR1", signalSpy);
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
  }
}

// Other gateway test helpers (test-helpers.mocks.ts, test-helpers.server.ts)
// set OPENCLAW_SKIP_CHANNELS / OPENCLAW_SKIP_PROVIDERS at module load. When a
// shared vitest worker imports those helpers before this file runs, the leaked
// env routes reloads into the skip branch and channel restarts never fire.
const testGatewayRestartListener = () => {};

beforeEach(() => {
  process.on("SIGUSR1", testGatewayRestartListener);
  resetProcessRegistryForTests();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

afterEach(() => {
  process.removeListener("SIGUSR1", testGatewayRestartListener);
  setGatewaySigusr1RestartPolicy({ allowExternal: false });
  vi.useRealTimers();
  resetProcessRegistryForTests();
  hoisted.startGmailWatcherWithLogs.mockClear();
  hoisted.stopGmailWatcher.mockClear();
  hoisted.activeTaskCount.value = 0;
  hoisted.activeTaskBlockers.length = 0;
  hoisted.activeEmbeddedRunCount.value = 0;
  hoisted.activeEmbeddedRunSessionIds.length = 0;
  hoisted.activeEmbeddedRunSessionKeys.length = 0;
  hoisted.markRestartAbortedMainSessions.mockClear();
  hoisted.runtimeConfig.value = { session: { store: "/tmp/active-sessions.json" } };
  hoisted.reloadEvents.length = 0;
  hoisted.loadModelCatalog.mockClear();
  hoisted.resetModelCatalogCache.mockClear();
  hoisted.refreshContextWindowCache.mockClear();
  hoisted.clearCurrentProviderAuthState.mockClear();
  hoisted.warmCurrentProviderAuthStateOffMainThread.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockResolvedValue(undefined);
  hoisted.buildGatewayCronService.mockClear();
  clearSecretsRuntimeSnapshot();
});

describe("gateway hot reload model state", () => {
  it("stops old cron exit watchers and reconciles rebuilt ones after cron restart", async () => {
    const order: string[] = [];
    const newCron = {
      start: vi.fn(async () => {
        order.push("start-new");
      }),
      stop: vi.fn(),
    };
    const newReconcileExitWatchers = vi.fn(async () => {
      order.push("reconcile-watchers");
    });
    const rebuiltCronState = {
      cron: newCron,
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: newReconcileExitWatchers,
      stopExitWatchers: vi.fn(),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce(() => {
      order.push("build-new");
      return rebuiltCronState;
    });
    const { applyHotReload, cron, cronReconciliation, setState, stopExitWatchers } =
      createReloadHandlersForTest();
    cron.stop.mockImplementation(() => {
      order.push("stop-old");
    });
    stopExitWatchers.mockImplementation(() => {
      order.push("stop-old-watchers");
    });
    cronReconciliation.invalidate.mockImplementation(() => {
      order.push("invalidate-old");
    });
    cronReconciliation.arm.mockImplementation(() => ({
      complete: async () => {
        order.push("hook");
      },
    }));
    const nextConfig = { cron: { enabled: true } } as OpenClawConfig;

    await withGatewayRestartSignal(async () => {
      await applyHotReload(createCronRestartPlan(), nextConfig);
    });

    expect(cron.stop).toHaveBeenCalledTimes(1);
    expect(stopExitWatchers).toHaveBeenCalledTimes(1);
    expect(newCron.start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(newReconcileExitWatchers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(order.at(-1)).toBe("hook"));
    expect(order).toEqual([
      "build-new",
      "invalidate-old",
      "stop-old",
      "stop-old-watchers",
      "start-new",
      "reconcile-watchers",
      "hook",
    ]);
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "reload",
      config: nextConfig,
      cronState: rebuiltCronState,
    });
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        cronState: rebuiltCronState,
      }),
    );
  });

  it("completes reload reconciliation when the replacement scheduler is disabled", async () => {
    const rebuiltCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: false,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
    };
    hoisted.buildGatewayCronService.mockReturnValueOnce(rebuiltCronState);
    const { applyHotReload, cronReconciliation } = createReloadHandlersForTest();
    const nextConfig = { cron: { enabled: false } } as OpenClawConfig;

    await withGatewayRestartSignal(async () => {
      await applyHotReload(createCronRestartPlan(), nextConfig);
    });

    await vi.waitFor(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "reload",
      config: nextConfig,
      cronState: rebuiltCronState,
    });
  });

  it("rejects cron reload before commit when recovery restart is unavailable", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const { applyHotReload, cron, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );

    await expect(
      applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }),
    ).rejects.toThrow("config hot reload recovery is unavailable");

    expect(setState).not.toHaveBeenCalled();
    expect(cron.stop).not.toHaveBeenCalled();
  });

  it("restarts when the replacement cron fails after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    hoisted.buildGatewayCronService.mockReturnValueOnce({
      cron: {
        start: vi.fn(async () => {
          throw new Error("cron start failed");
        }),
        stop: vi.fn(),
      },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
    });
    const { applyHotReload, setState } = createReloadHandlersForTest(logReload);

    try {
      await expect(
        applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }),
      ).resolves.toBeUndefined();

      expect(setState).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(signalSpy).toHaveBeenCalledOnce());
      expect(logReload.warn).toHaveBeenCalledWith(
        "cron reload failed after config commit: cron start failed; restarting gateway",
      );
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("ignores a delayed cron failure after a newer reload supersedes it", async () => {
    let rejectFirstStart: ((reason: Error) => void) | undefined;
    const firstCronState = {
      cron: {
        start: vi.fn(
          async () =>
            await new Promise<void>((_resolve, reject) => {
              rejectFirstStart = reject;
            }),
        ),
        stop: vi.fn(),
      },
      storePath: "/tmp/first-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
    };
    const secondCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/second-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
    };
    hoisted.buildGatewayCronService
      .mockReturnValueOnce(firstCronState)
      .mockReturnValueOnce(secondCronState);
    const { applyHotReload, logCron } = createReloadHandlersForTest();

    await withGatewayRestartSignal(async (signalSpy) => {
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      await vi.waitFor(() => expect(firstCronState.cron.start).toHaveBeenCalledOnce());
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      rejectFirstStart?.(new Error("superseded start failed"));
      await vi.waitFor(() =>
        expect(logCron.error).toHaveBeenCalledWith(
          "failed to start: Error: superseded start failed",
        ),
      );
      expect(signalSpy).not.toHaveBeenCalled();
    });
  });

  it("restarts instead of rolling back when cron teardown fails after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
    const { applyHotReload, cron, setState } = createReloadHandlersForTest(logReload);
    cron.stop.mockImplementation(() => {
      throw new Error("cron stop failed");
    });

    try {
      await expect(
        applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }, { publish }),
      ).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "runtime commit failed after config commit: cron stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("resets prepared model runtime state for every hot reload and rewarms after plugin reload", async () => {
    const reloadPlugins = vi.fn(async (): Promise<GatewayPluginReloadResult> => {
      hoisted.reloadEvents.push("reload-plugins");
      return {
        restartChannels: new Set(),
        activeChannels: new Set(),
      };
    });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    const nextConfig = { plugins: { enabled: true } } as OpenClawConfig;
    await applyHotReload(
      {
        changedPaths: ["plugins.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["plugins.enabled"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: true,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    const firstResetIndex = hoisted.reloadEvents.indexOf("reset-model-catalog");
    expect(firstResetIndex).toBeGreaterThanOrEqual(0);
    expect(hoisted.reloadEvents.slice(firstResetIndex)).toEqual([
      "reset-model-catalog",
      "clear-provider-auth",
      "reload-plugins",
      "reset-model-catalog",
      "clear-provider-auth",
      "refresh-context-window",
      "load-model-catalog",
      "warm-provider-auth",
    ]);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(hoisted.loadModelCatalog).toHaveBeenCalledWith({ config: nextConfig });
    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith(nextConfig);
  });

  it("disposes cached MCP runtimes on MCP config hot reloads", async () => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = { mcp: { servers: {} } } as OpenClawConfig;

    await applyHotReload(
      {
        changedPaths: ["mcp.servers.context7.command"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["mcp.servers.context7.command"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: true,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.disposeAllSessionMcpRuntimes).toHaveBeenCalledTimes(1);
    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith(nextConfig);
  });

  it("refreshes context metadata when the default workspace changes", async () => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = {
      agents: { defaults: { workspace: "/tmp/next-workspace" } },
    } as OpenClawConfig;

    await applyHotReload(
      {
        changedPaths: ["agents.defaults.workspace"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["agents.defaults.workspace"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
  });

  it.each([
    {
      label: "adds the agents object",
      previousConfig: {},
      nextConfig: { agents: { defaults: { workspace: "/tmp/next-workspace" } } },
      expectedPath: "agents",
    },
    {
      label: "removes the defaults object",
      previousConfig: { agents: { defaults: { workspace: "/tmp/previous-workspace" } } },
      nextConfig: { agents: {} },
      expectedPath: "agents.defaults",
    },
  ])("refreshes context metadata when a workspace change $label", async (testCase) => {
    const { applyHotReload } = createReloadHandlersForTest();
    const previousConfig = testCase.previousConfig as OpenClawConfig;
    const nextConfig = testCase.nextConfig as OpenClawConfig;
    const changedPaths = diffConfigPaths(previousConfig, nextConfig);
    expect(changedPaths).toEqual([testCase.expectedPath]);

    await applyHotReload(buildGatewayReloadPlan(changedPaths), nextConfig);

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
  });
});

describe("gateway hot reload commit policy", () => {
  it("preserves SIGUSR1 policy when hook preparation rejects the config", async () => {
    setGatewaySigusr1RestartPolicy({ allowExternal: false });
    const { applyHotReload } = createReloadHandlersForTest();

    await expect(
      applyHotReload(
        {
          changedPaths: ["commands.restart", "hooks.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["commands.restart", "hooks.enabled"],
          reloadHooks: true,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { commands: { restart: true }, hooks: { enabled: true } },
      ),
    ).rejects.toThrow("hooks.enabled requires hooks.token");

    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
  });
});

describe("gateway restart deferral preflight", () => {
  it("retries an immediate restart when signal admission fails", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("recovery-pending");
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("retires only retries owned by a rejected config transaction", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValue({ status: "failed" });
    const { requestGatewayRestart, retireRejectedRestartRequest, stopRestartRetries } =
      createReloadHandlersForTest(
        undefined,
        undefined,
        undefined,
        undefined,
        requestRecoveryRestart,
      );
    const restartPlan = {
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    } satisfies GatewayReloadPlan;
    vi.useFakeTimers();

    try {
      const rejected = requestGatewayRestart(restartPlan, {});
      rejected.settle("rejected");
      expect(retireRejectedRestartRequest()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      const committed = requestGatewayRestart(restartPlan, {});
      committed.settle("committed");
      expect(retireRejectedRestartRequest()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(3);
    } finally {
      stopRestartRetries();
    }
  });

  it("cancels a failed restart retry when a newer restart supersedes it", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { gateway: { port: 18790 } },
        ).status,
      ).toBe("recovery-pending");

      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.auth"],
            restartGateway: true,
            restartReasons: ["gateway.auth"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { gateway: { port: 18791 } },
        ).status,
      ).toBe("accepted");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
    }
  });

  it("holds root admission across an immediate config-reload restart signal", () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const { requestGatewayRestart } = createReloadHandlersForTest();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

      markGatewaySigusr1RestartHandled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers config restart until a background exec actually exits", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    const session = createProcessSessionFixture({
      id: "background-restart-blocker",
      command: "private command",
      pid: 12345,
    });
    addSession(session);
    markBackgrounded(session);
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

      expect(signalSpy).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "config change requires gateway restart (gateway.port) — deferring until 1 background exec session(s) complete",
      );

      markExited(session, 0, null, "completed");
      await vi.advanceTimersByTimeAsync(500);

      expect(signalSpy).toHaveBeenCalledOnce();
      expect(logReload.info).toHaveBeenCalledWith(
        "all operations and replies completed; restarting gateway now",
      );
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("keeps retrying a deferred restart until signal admission succeeds", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const session = createProcessSessionFixture({
      id: "background-restart-retry",
      command: "private command",
      pid: 12346,
    });
    addSession(session);
    markBackgrounded(session);
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

      markExited(session, 0, null, "completed");
      await vi.advanceTimersByTimeAsync(500);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart recovery emission failed; retrying",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(3);
    } finally {
      stopRestartRetries();
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("retries a timed-out deferral with its original force intent", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    hoisted.activeTaskBlockers.push({
      taskId: "force-intent-blocker",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const transaction = requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { gateway: { reload: { deferralTimeoutMs: 500 } } },
      );
      transaction.settle("committed");

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: gateway.port", { force: true, reason: "config reload forced restart" }],
        ["config reload: gateway.port", { force: true, reason: "config reload forced restart" }],
      ]);
      expect(
        logReload.warn.mock.calls.filter(([message]) =>
          message.includes("deferring until 1 background task run(s) complete"),
        ),
      ).toHaveLength(1);
    } finally {
      stopRestartRetries();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("defers config restart across an admitted process handoff", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    const handoff = tryBeginGatewayIndependentRootWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");
      expect(signalSpy).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "config change requires gateway restart (gateway.port) — deferring until 1 gateway request(s) complete",
      );

      handoff?.release();
      await vi.advanceTimersByTimeAsync(500);

      expect(signalSpy).toHaveBeenCalledOnce();
    } finally {
      handoff?.release();
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers channel hot reload until active embedded work drains", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const setState = vi.fn();
    let runtimePublished = false;
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 60_000 } },
        channels: { discord: { token: "token" } },
      },
      {
        publish: async (commit) => {
          runtimePublished = true;
          await commit();
        },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(runtimePublished).toBe(false);
      expect(setState).not.toHaveBeenCalled();

      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(runtimePublished).toBe(true);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("forces channel hot reload after the configured deferral timeout", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 1_000 } },
        channels: { discord: { token: "token" } },
      },
    );
    try {
      await Promise.resolve();
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
  });

  it("uses the default channel reload deferral timeout when config omits deferralTimeoutMs", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.telegram.botToken"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.telegram.botToken"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["telegram"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        channels: { telegram: { botToken: "token" } },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(299_500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("telegram", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("telegram");
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
  });

  it("waits indefinitely for channel hot reload when deferral timeout is 0", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 0 } },
        channels: { discord: { token: "token" } },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(logReload.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("channel reload timeout after"),
      );

      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
  });

  it("logs active task run ids before waiting and when forcing after timeout", async () => {
    restartTesting.resetSigusr1State();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    hoisted.activeTaskCount.value = 1;
    hoisted.activeEmbeddedRunSessionIds.push("session-issue-82433");
    hoisted.activeEmbeddedRunSessionKeys.push("agent:main:issue-82433");
    hoisted.activeTaskBlockers.push({
      taskId: "task-nightly",
      runId: "run-nightly",
      status: "running",
      runtime: "cron",
      label: "nightly sync",
      title: "refresh all accounts",
    });
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          gateway: { reload: { deferralTimeoutMs: 1_000 } },
        },
      );

      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(consumeGatewaySigusr1RestartIntent()).toEqual({
        force: true,
        reason: "config reload forced restart",
      });
      expect(hoisted.markRestartAbortedMainSessions).toHaveBeenCalledWith({
        cfg: {
          gateway: { reload: { deferralTimeoutMs: 1_000 } },
        },
        additionalCfgs: [{ session: { store: "/tmp/active-sessions.json" } }],
        sessionIds: new Set(["session-issue-82433"]),
        sessionKeys: new Set(["agent:main:issue-82433"]),
        reason: "config reload forced restart",
      });
      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
        [
          "restart timeout after 1000ms with 1 background task run(s) still active (taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts); forcing restart",
        ],
      ]);
    } finally {
      hoisted.activeTaskCount.value = 0;
      vi.useRealTimers();
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
    }
  });

  it("uses the default restart deferral timeout when config omits deferralTimeoutMs", async () => {
    restartTesting.resetSigusr1State();
    const { requestGatewayRestart } = createReloadHandlersForTest();
    hoisted.activeTaskCount.value = 1;
    hoisted.activeTaskBlockers.push({
      taskId: "task-running-1",
      status: "running",
      runtime: "subagent",
    });
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {},
      );

      await vi.advanceTimersByTimeAsync(299_500);
      expect(signalSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(signalSpy).toHaveBeenCalledTimes(1);
    } finally {
      hoisted.activeTaskCount.value = 0;
      process.removeListener("SIGUSR1", signalSpy);
      vi.useRealTimers();
      restartTesting.resetSigusr1State();
    }
  });
});

describe("gateway channel hot reload handlers", () => {
  function createChannelReloadPlan(channels: ChannelKind[]): GatewayReloadPlan {
    return {
      changedPaths: channels.map((channel) => `channels.${channel}.enabled`),
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["channels"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set(channels),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  }

  async function withChannelReloadsEnabled(run: () => Promise<void>) {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    try {
      await run();
    } finally {
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
    }
  }

  it("refuses channel restarts while crash-loop safe mode suppresses autostart", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      stopPostReadySidecars: vi.fn(),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    await withChannelReloadsEnabled(() => applyHotReload(createChannelReloadPlan(["discord"]), {}));

    expect(channels.stop).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(channels.start).not.toHaveBeenCalled();
    expect(logChannels.info).toHaveBeenCalledWith(
      "stopping discord channel before suppressed hot reload",
    );
    expect(logChannels.info).toHaveBeenCalledWith(
      "channel restart during hot reload suppressed by crash-loop breaker for channels: discord",
    );
  });

  it("restarts WhatsApp when the planner receives a selfChatMode change", async () => {
    const whatsappPlugin = {
      ...createChannelTestPluginBase({ id: "whatsapp" }),
      reload: {
        configPrefixes: ["web", "channels.whatsapp.accounts", "channels.whatsapp.selfChatMode"],
        noopPrefixes: ["channels.whatsapp"],
      },
    };
    const registry = createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    ]);
    const events: string[] = [];
    const channels = {
      stop: vi.fn(async (channel: ChannelKind) => {
        events.push(`stop:${channel}`);
      }),
      start: vi.fn(async (channel: ChannelKind) => {
        events.push(`start:${channel}`);
      }),
    };

    pinActivePluginChannelRegistry(registry);
    try {
      const plan = buildGatewayReloadPlan(["channels.whatsapp.selfChatMode"]);
      const { applyHotReload } = createReloadHandlersForTest(undefined, channels);

      expect(plan.restartGateway).toBe(false);
      expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
      await withChannelReloadsEnabled(() => applyHotReload(plan, {}));

      expect(events).toEqual(["stop:whatsapp", "start:whatsapp"]);
    } finally {
      releasePinnedPluginChannelRegistry(registry);
    }
  });

  it("continues restarting later channels after a hot-reload stop failure", async () => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "telegram") {
        throw new Error("stop failed");
      }
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    await withGatewayRestartSignal(async (signalSpy) => {
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBeUndefined();
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(["stop:telegram", "stop:discord", "start:discord"]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to restart telegram channel during hot reload: stop failed",
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });

  it("continues restarting later channels after a hot-reload start failure", async () => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      if (channel === "telegram") {
        throw new Error("start failed");
      }
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    await withGatewayRestartSignal(async (signalSpy) => {
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBeUndefined();
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(["stop:telegram", "start:telegram", "stop:discord", "start:discord"]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to restart telegram channel during hot reload: start failed",
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });
});

describe("gateway Gmail hot reload handlers", () => {
  function createGmailReloadPlan(): GatewayReloadPlan {
    return {
      changedPaths: ["hooks.gmail.account"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["hooks.gmail.account"],
      reloadHooks: false,
      restartGmailWatcher: true,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  }

  function createGmailConfig(account: string): OpenClawConfig {
    return {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, gmail: { account } },
    };
  }

  it("stops queued post-ready sidecars before restarting Gmail watcher", async () => {
    const stopPostReadySidecars = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      stopPostReadySidecars,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });
    const nextConfig = {
      hooks: { enabled: true, gmail: { account: "next@example.com" } },
    } as never;

    await applyHotReload(
      {
        changedPaths: ["hooks.gmail.account"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["hooks.gmail.account"],
        reloadHooks: false,
        restartGmailWatcher: true,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
    expect(stopPostReadySidecars).toHaveBeenCalledBefore(hoisted.stopGmailWatcher);
    expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: nextConfig }),
    );
  });

  it("restarts when post-ready sidecar teardown fails after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopPostReadySidecars = vi.fn(async () => {
      throw new Error("sidecar stop failed");
    });
    const { applyHotReload, setState } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      stopPostReadySidecars,
    );

    try {
      await expect(
        applyHotReload(createGmailReloadPlan(), createGmailConfig("next@example.com")),
      ).resolves.toBeUndefined();

      expect(stopPostReadySidecars).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gmail watcher reload failed after config commit: sidecar stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("passes a cancellable signal to Gmail watcher restarts", async () => {
    const abortController = new AbortController();
    const clearGmailRestartAbortController = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
      createGmailRestartAbortController: () => abortController,
      clearGmailRestartAbortController,
    });
    const nextConfig = createGmailConfig("next@example.com");

    await applyHotReload(createGmailReloadPlan(), nextConfig);

    const [restartParams] = hoisted.startGmailWatcherWithLogs.mock.calls[0] ?? [];
    expect(restartParams).toMatchObject({ cfg: nextConfig });
    expect(restartParams?.signal).toBe(abortController.signal);
    expect(restartParams?.isCancelled?.()).toBe(false);
    abortController.abort();
    expect(restartParams?.isCancelled?.()).toBe(true);
    expect(clearGmailRestartAbortController).toHaveBeenCalledWith(abortController);
  });

  it("commits runtime secrets for managed no-op config reloads", async () => {
    vi.useFakeTimers();
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      messages: { visibleReplies: "message_tool" },
    };
    const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig) => ({
      sourceConfig: config,
      config,
      authStores: [],
      warnings: [],
      webTools: {},
    }));
    const heartbeatRunner = { stop: vi.fn(), updateConfig: vi.fn() };
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(nextConfig, {
      reason: "reload",
      activate: true,
    });
    expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
    await reloader.stop();
  });

  it("retries managed hot reload when secrets change before publication", async () => {
    vi.useFakeTimers();
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig = {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, token: "test-token", path: "/next" },
    } as OpenClawConfig;
    const initialSnapshot = {
      sourceConfig: initialConfig,
      config: initialConfig,
      authStores: [],
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    const refreshedSnapshot = {
      ...initialSnapshot,
      authStores: [{ source: "refreshed" }],
    } as never;
    activateSecretsRuntimeSnapshot(initialSnapshot);
    const initialSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
    const activatePreparedSnapshotIfCurrent = vi.fn(
      async (
        snapshot: PreparedSecretsRuntimeSnapshot,
        expectedRevision: number,
        _params: unknown,
        onActivated?: () => Promise<void>,
      ) => {
        if (getActiveSecretsRuntimeSnapshotRevision() !== expectedRevision) {
          return null;
        }
        activateSecretsRuntimeSnapshot(snapshot);
        await onActivated?.();
        return snapshot;
      },
    );
    let preparationCount = 0;
    const activateRuntimeSecrets = Object.assign(
      vi.fn(async (config: OpenClawConfig) => {
        preparationCount += 1;
        if (preparationCount === 1) {
          activateSecretsRuntimeSnapshot(refreshedSnapshot);
        }
        return {
          sourceConfig: config,
          config,
          authStores: [],
          warnings: [],
          webTools: createEmptyRuntimeWebToolsMetadata(),
        };
      }),
      { activatePreparedSnapshotIfCurrent },
    );
    const commitTerminalConfig = vi.fn();
    const promoteSnapshot = vi.fn(async () => true);
    const setState = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig,
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hot-reload-next",
      revision: 1,
      fingerprint: "runtime-hot-reload-next",
      sourceFingerprint: "source-hot-reload-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();
    await reloader.stop();

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(2);
    expect(activatePreparedSnapshotIfCurrent).toHaveBeenCalledOnce();
    expect(activatePreparedSnapshotIfCurrent.mock.calls[0]?.[1]).toBeGreaterThan(
      initialSnapshotRevision,
    );
    expect(setState).toHaveBeenCalledOnce();
    expect(commitTerminalConfig).toHaveBeenCalledOnce();
    expect(promoteSnapshot).toHaveBeenCalledOnce();
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(nextConfig);
  });

  it("aborts an in-flight managed Gmail restart when the reloader stops", async () => {
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    let restartSignal: AbortSignal | undefined;
    let restartEntered: (() => void) | undefined;
    const restartStarted = new Promise<void>((resolve) => {
      restartEntered = resolve;
    });
    hoisted.startGmailWatcherWithLogs.mockImplementationOnce(
      async (params: GmailWatcherRestartParams) => {
        restartSignal = params.signal;
        restartEntered?.();
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const readSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: nextConfig,
      resolved: nextConfig,
      valid: true,
      runtimeConfig: nextConfig,
      config: nextConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
      hash: "hash-next",
    }));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: readSnapshot as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await restartStarted;
    expect(restartSignal?.aborted).toBe(false);

    await reloader.stop();

    expect(restartSignal?.aborted).toBe(true);
  });

  it("keeps committed config after a Gmail watcher follow-up fails", async () => {
    vi.useFakeTimers();
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig: OpenClawConfig = {
      ...createGmailConfig("next@example.com"),
      models: { providers: {} },
    };
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    activateSecretsRuntimeSnapshot({
      sourceConfig: initialConfig,
      config: initialConfig,
      authStores: [],
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    });
    hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("start failed"));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledTimes(1);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(logReload.warn).toHaveBeenCalledWith(
      "gmail watcher reload failed after config commit: start failed; restarting gateway",
    );
    expect(logReload.error).not.toHaveBeenCalled();
    await reloader.stop();
  });

  it("does not start a Gmail restart after the managed reloader stops before hot reload applies", async () => {
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    let releaseSecrets: (() => void) | undefined;
    let secretsEntered: (() => void) | undefined;
    const secretsStarted = new Promise<void>((resolve) => {
      secretsEntered = resolve;
    });
    const releaseSecretsPromise = new Promise<void>((resolve) => {
      releaseSecrets = resolve;
    });
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => {
        secretsEntered?.();
        await releaseSecretsPromise;
        return {
          sourceConfig: config,
          config,
          authStores: [],
          warnings: [],
          webTools: {},
        };
      }) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await secretsStarted;

    const stopPromise = reloader.stop();
    releaseSecrets?.();
    await stopPromise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(hoisted.stopGmailWatcher).not.toHaveBeenCalled();
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });
});

describe("gateway plugin hot reload handlers", () => {
  it("keeps mixed reload state old until the plugin replacement commit", async () => {
    const events: string[] = [];
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        await params.commitRuntime();
        events.push("registry:replace");
        return { restartChannels: new Set(), activeChannels: new Set() };
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        start: vi.fn(async () => {}),
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
      },
      reloadPlugins,
    );
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();

    const reload = handlers.applyHotReload(
      {
        changedPaths: ["hooks.path", "plugins.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["hooks.path", "plugins.enabled"],
        reloadHooks: true,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: true,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      { hooks: { enabled: true, token: "token", path: "/next" } },
      {
        publish: async (commit) => {
          events.push("runtime:publish");
          await commit();
        },
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(["reload:start"]);
    expect(handlers.setState).not.toHaveBeenCalled();

    hoisted.activeEmbeddedRunCount.value = 0;
    await vi.advanceTimersByTimeAsync(500);
    await reload;

    expect(events).toEqual(["reload:start", "stop:discord", "runtime:publish", "registry:replace"]);
    expect(handlers.setState).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed plugin generation when a later channel restart fails", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.commitRuntime();
        return {
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        };
      },
    );
    const handlers = createReloadHandlersForTest(
      logReload,
      {
        start: vi.fn(async () => {
          throw new Error("start failed");
        }),
        stop: vi.fn(async () => {}),
      },
      reloadPlugins,
    );

    try {
      await expect(
        handlers.applyHotReload(
          {
            changedPaths: ["plugins.enabled"],
            restartGateway: false,
            restartReasons: [],
            hotReasons: ["plugins.enabled"],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: true,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { plugins: { enabled: true } },
          { publish: async (commit) => await commit() },
        ),
      ).resolves.toBeUndefined();

      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "channel restart (discord) failed after config commit; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("restarts instead of rolling back when plugin swap throws after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
    const handlers = createReloadHandlersForTest(
      logReload,
      undefined,
      vi.fn(async (params: { commitRuntime: () => Promise<void> }) => {
        await params.commitRuntime();
        throw new Error("swap failed");
      }),
    );

    try {
      await expect(
        handlers.applyHotReload(
          {
            changedPaths: ["plugins.enabled"],
            restartGateway: false,
            restartReasons: [],
            hotReasons: ["plugins.enabled"],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: true,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { plugins: { enabled: true } },
          { publish },
        ),
      ).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledOnce();
      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "plugin runtime reload failed after config commit: swap failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("rejects a fallible hot reload before commit when recovery is unavailable", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const publish = vi.fn(async () => {});
    const handlers = createReloadHandlersForTest(
      logReload,
      undefined,
      vi.fn(async (params: { commitRuntime: () => Promise<void> }) => {
        await params.commitRuntime();
        throw new Error("swap failed");
      }),
      vi.fn(),
      false,
    );

    await expect(
      handlers.applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { plugins: { enabled: true } },
        { publish },
      ),
    ).rejects.toThrow("config hot reload recovery is unavailable");

    expect(publish).not.toHaveBeenCalled();
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("restarts pre-stopped channels when runtime publication fails", async () => {
    const events: string[] = [];
    const publish = vi.fn(async () => {
      throw new Error("publication failed");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        await params.commitRuntime();
        return { restartChannels: new Set(), activeChannels: new Set(["discord"]) };
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
        start: vi.fn(async (channel) => {
          events.push(`start:${channel}`);
        }),
      },
      reloadPlugins,
    );

    await expect(
      handlers.applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { plugins: { enabled: true } },
        { publish },
      ),
    ).rejects.toThrow("publication failed");

    expect(events).toEqual(["stop:discord", "start:discord"]);
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("restarts pre-stopped channels when plugin replacement is cancelled", async () => {
    const events: string[] = [];
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        isAborted?: () => boolean;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        abortPendingChannelReloads();
        expect(params.isAborted?.()).toBe(true);
        return { restartChannels: new Set(), activeChannels: new Set(), cancelled: true };
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
        start: vi.fn(async (channel) => {
          events.push(`start:${channel}`);
        }),
      },
      reloadPlugins,
    );

    await expect(
      handlers.applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { plugins: { enabled: true } },
      ),
    ).rejects.toThrow("config hot reload cancelled by in-process restart");

    expect(events).toEqual(["stop:discord", "start:discord"]);
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("rolls back stopped channels when plugin pre-replace stop fails", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const events: string[] = [];
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
    });
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "discord") {
        throw new Error("stop failed");
      }
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["telegram", "discord"]));
        events.push("registry:replace");
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await expect(
        applyHotReload(
          {
            changedPaths: ["plugins.enabled"],
            restartGateway: false,
            restartReasons: [],
            hotReasons: ["plugins.enabled"],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: true,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {
            plugins: {
              enabled: false,
            },
          },
        ),
      ).rejects.toThrow("failed to stop channels before plugin reload: discord");
    } finally {
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
    }

    expect(events).toEqual([
      "reload:start",
      "stop:telegram",
      "stop:discord",
      "start:telegram",
      "start:discord",
    ]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to stop discord channel before plugin reload: stop failed",
    );
    expect(startChannel).toHaveBeenCalledWith("telegram");
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(setState).not.toHaveBeenCalled();
  });

  it("stops removed channel plugins from broad activation before swapping plugin runtime", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const startChannel = vi.fn(async () => {});
    const events: string[] = [];
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
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
    }

    const [reloadParams] = reloadPlugins.mock.calls.at(-1) ?? [];
    const reloadParamsRecord = reloadParams as
      | { nextConfig?: unknown; changedPaths?: unknown }
      | undefined;
    expect(reloadParamsRecord?.nextConfig).toEqual({
      plugins: {
        enabled: false,
      },
    });
    expect(reloadParamsRecord?.changedPaths).toEqual(["plugins.enabled"]);
    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop", "registry:replace"]);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("stops manually started channels before plugin replacement while autostart is suppressed", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const events: string[] = [];
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
    });
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return {
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop:discord", "registry:replace"]);
    expect(logChannels.info).toHaveBeenCalledWith(
      "channel restart during hot reload suppressed by crash-loop breaker for channels: discord",
    );
    expect(setState).toHaveBeenCalledTimes(1);
  });
});

describe("deferred channel reload abort generation", () => {
  const abortChannelReloadPlan: GatewayReloadPlan = {
    changedPaths: ["channels.whatsapp.enabled"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["channels"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(["whatsapp"]),
    disposeMcpRuntimes: false,
    noopPaths: [],
  };

  afterEach(() => {
    hoisted.activeTaskCount.value = 0;
    vi.useRealTimers();
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  });

  const createTestHandlers = (logChannels: any, channels: any) =>
    createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      stopPostReadySidecars: vi.fn(),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

  it("abortPendingChannelReloads cancels a waiting deferred channel reload", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createTestHandlers(logChannels, channels);

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(abortChannelReloadPlan, {});
      await vi.advanceTimersByTimeAsync(10); // enter wait loop (before 500ms sleep)

      abortPendingChannelReloads();
      await vi.advanceTimersByTimeAsync(500); // wake from poll sleep → abort check
      await expect(reloadPromise).rejects.toThrow(
        "config hot reload cancelled by in-process restart",
      );

      expect(channels.start).not.toHaveBeenCalled();
      expect(logChannels.info).toHaveBeenCalledWith(
        "channel restart cancelled by in-process restart",
      );
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("does not mark a managed reload applied when restart aborts its deferral", async () => {
    const initialConfig = {
      gateway: { reload: { debounceMs: 0 } },
      channels: { whatsapp: { enabled: true } },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: { debounceMs: 0 } },
      channels: { whatsapp: { enabled: false } },
    } as OpenClawConfig;
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const commitTerminalConfig = vi.fn();
    const promoteSnapshot = vi.fn(async () => true);
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig,
      retireTerminalRestartConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }
    hoisted.activeTaskBlockers.push({
      taskId: "managed-reload-blocker",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      registeredWriteListener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        persistedHash: "managed-abort-next",
        revision: 1,
        fingerprint: "runtime-managed-abort-next",
        sourceFingerprint: "source-managed-abort-next",
        writtenAtMs: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(10);
      abortPendingChannelReloads();
      await vi.advanceTimersByTimeAsync(500);

      expect(commitTerminalConfig).not.toHaveBeenCalled();
      expect(promoteSnapshot).not.toHaveBeenCalled();
      expect(logReload.error).toHaveBeenCalledWith(
        "config reload failed: GatewayHotReloadCancelledError: config hot reload cancelled by in-process restart",
      );
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      await reloader.stop();
    }
  });

  it("new reload lifecycle is not affected by a previous lifecycle abort", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    // Create gen 1 and register abort for it
    createTestHandlers(logChannels, channels);
    abortPendingChannelReloads();

    // Create gen 2 — should not carry over the abort from gen 1
    const h2 = createTestHandlers(logChannels, channels);

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload-g2",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const reloadPromise = h2.applyHotReload(abortChannelReloadPlan, {});
      await vi.advanceTimersByTimeAsync(600); // past first poll interval — still waiting
      await Promise.resolve();

      // Gen 2's generation > abort generation, so it should NOT abort
      expect(logChannels.info).not.toHaveBeenCalledWith(
        "channel restart cancelled by in-process restart",
      );

      // Drain active work → should proceed to stop/start channels normally
      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500); // wake up, see active=0, drain complete
      await expect(reloadPromise).resolves.toBeUndefined();

      expect(channels.stop).toHaveBeenCalledWith("whatsapp", undefined, { manual: false });
      expect(channels.start).toHaveBeenCalledWith("whatsapp");
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("abort inside beforeReplace prevents plugin metadata/runtime replacement and channel restart", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    let receivedIsAborted = false;
    let reloadWasCancelled = false;
    const reloadPlugins = vi.fn(
      async (params: {
        nextConfig: OpenClawConfig;
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        isAborted?: () => boolean;
      }): Promise<GatewayPluginReloadResult> => {
        if (params.isAborted) {
          receivedIsAborted = true;
        }
        await params.beforeReplace(new Set(["whatsapp"]));
        if (params.isAborted?.()) {
          reloadWasCancelled = true;
          return { restartChannels: new Set(), activeChannels: new Set(), cancelled: true };
        }
        return { restartChannels: new Set(), activeChannels: new Set() };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      stopPostReadySidecars: vi.fn(),
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    const pluginReloadPlan: GatewayReloadPlan = {
      changedPaths: ["plugins.enabled"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["plugins.enabled"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: true,
      restartChannels: new Set(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(pluginReloadPlan, {});
      // Advance into the waitForActiveWorkBeforeChannelReload poll loop
      await vi.advanceTimersByTimeAsync(100);
      abortPendingChannelReloads();
      // Advance past the 500ms sleep → abort check fires
      await vi.advanceTimersByTimeAsync(500);
      await expect(reloadPromise).rejects.toThrow(
        "config hot reload cancelled by in-process restart",
      );

      // reloadPlugins should receive the isAborted callback
      expect(receivedIsAborted).toBe(true);
      // reloadPlugins should detect abort and return cancelled
      expect(reloadWasCancelled).toBe(true);
      // beforeReplace cancellation log
      expect(logChannels.info).toHaveBeenCalledWith(
        "channel reload before plugin replace cancelled by in-process restart",
      );
      // No channel should be started — cancelledByRestart = pluginReloadAborted = true
      expect(channels.start).not.toHaveBeenCalled();
      expect(channels.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });
});
