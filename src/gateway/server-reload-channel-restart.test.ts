import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { writeProviderAuthConfig } from "../plugins/provider-auth-config.js";
import {
  createPluginRegistryOwner,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { channelBlockedPatch, channelReadyPatch } from "./channel-status-patches.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";

async function reloadChannels(
  owner: ChannelManager,
  getPluginRegistry: typeof requireActivePluginChannelRegistry,
  channels: Set<ChannelKind>,
  logChannels: Parameters<typeof restartGatewayChannels>[0]["params"]["logChannels"],
  scheduleRecoveryRestart: Parameters<typeof restartGatewayChannels>[0]["scheduleRecoveryRestart"],
) {
  await restartGatewayChannels({
    params: {
      startChannel: owner.startChannel,
      stopChannel: owner.stopChannel,
      getPluginRegistry,
      releaseChannelRouteHandoffs: owner.releaseChannelRouteHandoffs,
      logChannels,
    },
    nextConfig: {},
    channelsToRestart: channels,
    restartChannelAccounts: new Map(),
    activePluginChannelsAfterReload: null,
    shouldSkipChannelRestart: false,
    skipChannelRestartLogMessage: "",
    isLifecycleReloadAborted: () => false,
    getChannelAutostartSuppression: () => null,
    channelReloadTargets: () => channels,
    logSuppressedChannelRestart: vi.fn(),
    scheduleRecoveryRestart,
  });
}

// Hot-reload recovery: collapse the restart and backoff ladders so a re-driven
// replacement reaches its next attempt inside the fake-timer budget.
const reloadRecoveryHoisted = vi.hoisted(() => {
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { sleepWithAbort };
});

vi.mock("../../packages/retry/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/retry/src/index.js")>();
  class TestRetrySupervisor extends actual.RetrySupervisor {
    constructor(
      _policy: ConstructorParameters<typeof actual.RetrySupervisor>[0],
      maxAttempts?: number,
    ) {
      super({ initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }, maxAttempts);
    }
  }
  return { ...actual, RetrySupervisor: TestRetrySupervisor };
});

vi.mock("../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/backoff.js")>();
  return { ...actual, sleepWithAbort: reloadRecoveryHoisted.sleepWithAbort };
});

let manager: ChannelManager | undefined;
afterEach(async () => {
  await manager?.stopChannel("discord");
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it("the config watcher restarts a channel that can save provider settings after reload closes", async () => {
  await withOpenClawTestState({ label: "channel-reload-login" }, async (state) => {
    const initialConfig = {
      gateway: { reload: { mode: "hybrid" as const } },
      commands: { ownerAllowFrom: ["telegram:1"] },
    };
    await state.writeConfig(initialConfig);
    const initial = await readConfigFileSnapshot();
    expect(initial.valid, JSON.stringify(initial.issues)).toBe(true);
    assert(initial.hash);
    const login = createDeferred();
    const restarted = createDeferred();
    const saved = createDeferred();
    const savedResult = saved.promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    const watcherReady = createDeferred();
    let starts = 0;
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "telegram" }),
      gateway: {
        startAccount: async ({ abortSignal }) => {
          const stopped = new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (++starts === 2) {
            restarted.resolve();
            await login.promise;
            try {
              const snapshot = await readConfigFileSnapshot();
              await writeProviderAuthConfig({
                config: snapshot.config,
                configSnapshot: snapshot,
                configPatch: {
                  models: {
                    providers: {
                      "lease-fixture": {
                        baseUrl: "https://fixture.invalid/v1",
                        api: "openai-completions",
                        models: [{ id: "account-model", name: "Account model" }],
                      },
                    },
                  },
                },
                credentialsSaved: true,
              });
              saved.resolve();
            } catch (error) {
              saved.reject(error);
            }
          }
          await stopped;
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    const owner = createChannelManager({
      getRuntimeConfig: () => initialConfig,
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    await owner.startChannel("telegram");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => restarted.reject(new Error(message))),
    };
    let assertReloadOwned: (() => void) | undefined;
    const reloader = startGatewayConfigReloader({
      initialConfig,
      initialSnapshotRawHash: initial.hash,
      initialAuthoredConfig: initial.parsed,
      initialSnapshotValid: initial.valid,
      initialSnapshotIssues: initial.issues,
      watchPath: state.configPath,
      readSnapshot: () => readConfigFileSnapshot(),
      onWatcherReady: watcherReady.resolve,
      onNoopConfigCommit: async () => {},
      onHotReload: async (plan, next, ownership) => {
        await withPluginLifecycleLease({}, async (lease) => {
          assertReloadOwned = () => lease.assertOwned();
        });
        await reloadChannels(
          owner,
          requireActivePluginChannelRegistry,
          plan.restartChannels,
          log,
          (surface) => {
            throw new Error(`unexpected restart recovery: ${surface}`);
          },
        );
        ownership.markRuntimeCommitted(next, plan);
        return "applied";
      },
      onRestart: () => {
        throw new Error("unexpected Gateway restart");
      },
      log,
    });
    try {
      await withTestTimeout(watcherReady.promise, 10_000, "config watcher did not start");
      await reloader.ready;
      await state.writeConfig({ ...initialConfig, commands: { ownerAllowFrom: ["telegram:2"] } });
      await withTestTimeout(
        restarted.promise,
        10_000,
        "config watcher did not restart the channel",
      );
      await expect.poll(() => reloader.isReloading()).toBe(false);
      assert(assertReloadOwned);
      expect(assertReloadOwned).toThrow(
        "plugin lifecycle lease core:plugin-lifecycle/global was lost",
      );
      login.resolve();
      await expect(
        withTestTimeout(savedResult, 10_000, "provider settings write did not settle"),
      ).resolves.toBeUndefined();
      const persisted = await readConfigFileSnapshot();
      expect(persisted.config.models?.providers?.["lease-fixture"]).toMatchObject({
        baseUrl: "https://fixture.invalid/v1",
        models: [{ id: "account-model", name: "Account model" }],
      });
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      login.resolve();
      await reloader.stop();
      await owner.stopChannel("telegram");
    }
  });
});

it("retries failed teardown before admitting a replacement", async () => {
  const retryStarted = createDeferred();
  const finishTeardown = createDeferred();
  const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const stopAccount = vi
    .fn()
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("teardown failed"))
    .mockImplementationOnce(async () => {
      retryStarted.resolve();
      await finishTeardown.promise;
    });
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["running"],
        resolveAccount: (_cfg, accountId) => ({ accountId }),
      },
    }),
    gateway: {
      startAccount,
      stopAccount,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
  manager = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  await manager.startChannel("discord");
  await expect(manager.stopChannel("discord", undefined, { manual: false })).rejects.toThrow(
    "teardown failed",
  );
  await expect(manager.startChannel("discord")).resolves.toEqual(
    new Map([["running", { status: "retry", reason: "stop-in-flight" }]]),
  );

  const channels = new Set<ChannelKind>(["discord"]);
  const logChannels = { info: vi.fn(), error: vi.fn() };
  const scheduleRecoveryRestart = vi.fn();
  const reload = reloadChannels(
    manager,
    requireActivePluginChannelRegistry,
    channels,
    logChannels,
    scheduleRecoveryRestart,
  );
  try {
    await retryStarted.promise;
    expect(startAccount).toHaveBeenCalledOnce();
    finishTeardown.resolve();
    await reload;
    expect(stopAccount).toHaveBeenCalledTimes(2);
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
  } finally {
    finishTeardown.resolve();
    await reload;
  }
});

it.each(
  (["channel", "accounts"] as const).flatMap((scope) =>
    (["idle", "stopped", "racing"] as const).map((state) => ({ scope, state })),
  ),
)(
  "$scope config reload preserves $state manual stops while explicit starts resume",
  async ({ scope, state }) => {
    const starts: string[] = [];
    const configuring = createDeferred();
    const releaseConfiguration = createDeferred();
    let blockConfiguration = state === "racing";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => ["manual", "running"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isConfigured: async (account) => {
            if (blockConfiguration && account.accountId === "manual") {
              configuring.resolve();
              await releaseConfiguration.promise;
            }
            return true;
          },
        },
      }),
      gateway: {
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    if (state === "stopped") {
      await manager.startChannel("discord", "manual");
      expect(starts).toEqual(["manual"]);
    }
    if (state !== "racing") {
      await manager.stopChannel("discord", "manual");
    }
    const channels = new Set<ChannelKind>(scope === "channel" ? ["discord"] : []);
    const accounts = new Map<ChannelKind, Set<string>>(
      scope === "accounts" ? [["discord", new Set(["manual", "running"])]] : [],
    );
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const scheduleRecoveryRestart = vi.fn();
    const reload = restartGatewayChannels({
      params: {
        startChannel: manager.startChannel,
        stopChannel: manager.stopChannel,
        getPluginRegistry: requireActivePluginChannelRegistry,
        releaseChannelRouteHandoffs: manager.releaseChannelRouteHandoffs,
        logChannels,
      },
      nextConfig: {},
      channelsToRestart: channels,
      restartChannelAccounts: accounts,
      activePluginChannelsAfterReload: null,
      shouldSkipChannelRestart: false,
      skipChannelRestartLogMessage: "",
      isLifecycleReloadAborted: () => false,
      getChannelAutostartSuppression: () => null,
      channelReloadTargets: () => channels,
      logSuppressedChannelRestart: vi.fn(),
      scheduleRecoveryRestart,
    });
    if (state === "racing") {
      await configuring.promise;
      await manager.stopChannel("discord", "manual");
      blockConfiguration = false;
      releaseConfiguration.resolve();
    }
    await reload;
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
    expect(manager.isManuallyStopped("discord", "manual")).toBe(true);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(false);
    expect(starts).toEqual(state === "stopped" ? ["manual", "running"] : ["running"]);

    await manager.startChannel("discord", "manual", { manual: true });
    expect(manager.isManuallyStopped("discord", "manual")).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(true);
    expect(starts.at(-1)).toBe("manual");
  },
);
it("channel reload uses the attached registry while another Gateway is active", async () => {
  const monitors: Array<{
    owner: string;
    channelId: ChannelKind;
    abortSignal: AbortSignal;
    joined: boolean;
  }> = [];
  const stopOwners: string[] = [];
  const createRegistry = (owner: string, channelIds: ChannelKind[]) =>
    createTestRegistry(
      channelIds.map((id) => {
        const plugin: ChannelPlugin = {
          ...createChannelTestPluginBase({ id }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              const monitor = { owner, channelId: id, abortSignal, joined: false };
              monitors.push(monitor);
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
              monitor.joined = true;
            },
            stopAccount: async () => {
              stopOwners.push(owner);
            },
          },
        };
        return { pluginId: id, plugin, source: "test" };
      }),
    );
  const ownedIds: ChannelKind[] = ["collision", "owner-only"];
  let attached = createRegistry("A-original", ownedIds);
  const current = createRegistry("A-current", ownedIds);
  const foreign = createRegistry("B", ["collision", "foreign-only"]);
  const registryOwnerA = createPluginRegistryOwner(attached);
  const registryOwnerB = createPluginRegistryOwner(foreign);
  const ownerA = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => attached,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const ownerB = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => foreign,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const stopOwnedChannels = async () => {
    for (const id of ownedIds) {
      await ownerA.stopChannel(id, undefined, { manual: false });
    }
  };
  try {
    setActivePluginRegistry(attached);
    await ownerA.startChannels();
    expect(monitors.map(({ owner }) => owner)).toEqual(["A-original", "A-original"]);
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    attached = current;
    setActivePluginRegistry(current);
    registryOwnerA.publish(current);
    await ownerA.startChannels();
    expect(monitors.slice(2).map(({ owner }) => owner)).toEqual(["A-current", "A-current"]);
    // Reload must resume this generation, not the manager's original registry.
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    setActivePluginRegistry(foreign);
    await ownerB.startChannels();
    const foreignMonitors = monitors.filter(({ owner }) => owner === "B");
    expect(foreignMonitors).toHaveLength(2);
    const beforeReload = monitors.length;
    const channels = new Set<ChannelKind>(ownedIds);
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const scheduleRecoveryRestart = vi.fn();
    await reloadChannels(ownerA, () => attached, channels, logChannels, scheduleRecoveryRestart);
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
    const resumed = monitors
      .slice(beforeReload)
      .map(({ owner, channelId }) => `${owner}:${channelId}`)
      .toSorted();
    const bInterrupted = foreignMonitors.some(
      ({ abortSignal, joined }) => abortSignal.aborted || joined,
    );
    expect(
      {
        resumed,
        aChannels: Object.keys(ownerA.getRuntimeSnapshot().channelAccounts).toSorted(),
        bChannels: Object.keys(ownerB.getRuntimeSnapshot().channelAccounts).toSorted(),
        bStopped: stopOwners.includes("B"),
        bInterrupted,
      },
      "reload borrowed a foreign or constructor-time channel registry",
    ).toEqual({
      resumed: ["A-current:collision", "A-current:owner-only"],
      aChannels: ["collision", "owner-only"],
      bChannels: ["collision", "foreign-only"],
      bStopped: false,
      bInterrupted: false,
    });
  } finally {
    for (const owner of [ownerA, ownerB]) {
      for (const id of ["collision", "owner-only", "foreign-only"]) {
        await owner.stopChannel(id);
      }
    }
    await registryOwnerA.close();
    await registryOwnerB.close();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);
  }
});

type StartAccount = NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;

/**
 * A config write (`openclaw doctor`) stops and re-admits every channel account the
 * changed config owns. A plugin channel that owns `gateway.startAccount` can lose that
 * handshake against its own still-live predecessor session and fail the replacement
 * start. A start that fails without publishing a terminal verdict is a recoverable
 * failure, so the existing bounded restart supervisor must re-drive it instead of
 * leaving the account wedged behind a manual `channels.start` RPC; a transport that
 * reports a terminal verdict keeps its operator-actionable diagnosis.
 */
describe("hot-reload replacement recovery", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    const stopping = manager?.stopChannel("discord").catch(() => {});
    manager = undefined;
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    vi.clearAllTimers();
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
  });

  function installPlugin(startAccount: StartAccount): void {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => [DEFAULT_ACCOUNT_ID],
          resolveAccount: () => ({}),
        },
      }),
      gateway: { startAccount },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
  }

  function createManager(): ChannelManager {
    return createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
  }

  /** The reload planner's own sequence: stop with a route handoff, then re-admit. */
  async function reloadAccount(target: ChannelManager): Promise<void> {
    await target.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false, routeHandoff: true });
    await target.startChannel("discord", DEFAULT_ACCOUNT_ID, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
  }

  async function flushMicrotasks(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  }

  async function advanceTimersUntil(
    check: () => boolean,
    message: string,
    options: { stepMs: number; maxMs: number },
  ): Promise<void> {
    for (let elapsed = 0; elapsed <= options.maxMs; elapsed += options.stepMs) {
      if (check()) {
        return;
      }
      await vi.advanceTimersByTimeAsync(options.stepMs);
      await flushMicrotasks();
    }
    if (check()) {
      return;
    }
    throw new Error(message);
  }

  function accountRuntime(target: ChannelManager) {
    return target.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
  }

  it("re-drives a reload replacement whose start fails recoverably before ready", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus, abortSignal }) => {
      starts += 1;
      if (starts === 2) {
        // The replacement lost the handshake against its own still-live predecessor
        // session. Its transport reports that as a recoverable start failure — no
        // terminal verdict — so the existing supervisor owns the re-drive and its
        // credentials never changed.
        throw new Error("session collision with the previous connection");
      }
      setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    manager = createManager();
    await manager.startChannels();
    await reloadAccount(manager);

    await advanceTimersUntil(
      () => starts >= 3,
      "reload replacement was not re-driven after a recoverable start failure",
      { stepMs: 10, maxMs: 1_000 },
    );
    await flushMicrotasks();
    expect(accountRuntime(manager)?.lifecycle).toBe("ready");
    expect(accountRuntime(manager)?.terminalDisconnect).toBeUndefined();
  });

  it("re-drives a recoverable start failure after a long-running predecessor", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus, abortSignal }) => {
      starts += 1;
      if (starts === 2) {
        throw new Error("session collision with the previous connection");
      }
      setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    manager = createManager();
    await manager.startChannels();
    await flushMicrotasks(30);
    expect(accountRuntime(manager)?.lifecycle).toBe("ready");
    // The predecessor connected, then stayed up far beyond any connection-age
    // window a recovery rule could have read after the reload had already
    // cleared `running`. Recoverable replacement starts do not depend on that.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await reloadAccount(manager);
    await advanceTimersUntil(
      () => starts >= 3,
      "a long-running predecessor left its recoverable replacement wedged",
      { stepMs: 10, maxMs: 1_000 },
    );
    await flushMicrotasks();
    expect(accountRuntime(manager)?.lifecycle).toBe("ready");
    expect(accountRuntime(manager)?.terminalDisconnect).toBeUndefined();
  });

  it("keeps a genuine terminal verdict operator-actionable on a reload replacement", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus, abortSignal }) => {
      starts += 1;
      if (starts === 2) {
        // Revoked credentials are terminal for the transport that reported them.
        setStatus(
          channelBlockedPatch("401 unauthorized: bot token rejected", {
            accountId: DEFAULT_ACCOUNT_ID,
          }),
        );
        return;
      }
      setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    manager = createManager();
    await manager.startChannels();
    await reloadAccount(manager);
    await flushMicrotasks(30);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(starts).toBe(2);
    expect(accountRuntime(manager)?.lifecycle).toBe("blocked");
    expect(accountRuntime(manager)?.terminalDisconnect).toBe(true);
    expect(accountRuntime(manager)?.restartPending).toBe(false);
    expect(accountRuntime(manager)?.lastError).toBe("401 unauthorized: bot token rejected");
  });

  it("still wedges a terminal disconnect without a reload", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus }) => {
      starts += 1;
      setStatus(channelBlockedPatch("relink required", { accountId: DEFAULT_ACCOUNT_ID }));
    });
    manager = createManager();
    await manager.startChannels();
    await flushMicrotasks(30);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(starts).toBe(1);
    expect(accountRuntime(manager)?.lifecycle).toBe("blocked");
    expect(accountRuntime(manager)?.restartPending).toBe(false);
  });
});
