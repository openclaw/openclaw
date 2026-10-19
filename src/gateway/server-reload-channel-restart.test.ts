import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createInfoErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred, withinTest, withTestTimeout } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { writeProviderAuthConfig } from "../plugins/provider-auth-config.js";
import {
  createPluginRegistryOwner,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";

async function reloadChannels(
  owner: ChannelManager,
  channels: Set<ChannelKind>,
  options: {
    registry?: typeof requireActivePluginChannelRegistry;
    log?: Parameters<typeof restartGatewayChannels>[0]["params"]["logChannels"];
    recover?: Parameters<typeof restartGatewayChannels>[0]["scheduleRecoveryRestart"];
    accounts?: Map<ChannelKind, Set<string>>;
  } = {},
) {
  const logChannels = options.log ?? createInfoErrorLogger();
  const recover = vi.fn(options.recover);
  await restartGatewayChannels({
    params: {
      startChannel: owner.startChannel,
      stopChannel: owner.stopChannel,
      getPluginRegistry: options.registry ?? requireActivePluginChannelRegistry,
      releaseChannelRouteHandoffs: owner.releaseChannelRouteHandoffs,
      logChannels,
    },
    nextConfig: {},
    channelsToRestart: channels,
    restartChannelAccounts: options.accounts ?? new Map(),
    activePluginChannelsAfterReload: null,
    shouldSkipChannelRestart: false,
    isLifecycleReloadAborted: () => false,
    getChannelAutostartSuppression: () => null,
    channelReloadTargets: () => channels,
    scheduleRecoveryRestart: recover,
  });
  expect(recover).not.toHaveBeenCalled();
  expect(logChannels.error).not.toHaveBeenCalled();
}

function channelManager(
  getPluginRegistry = requireActivePluginChannelRegistry,
  config: OpenClawConfig = {},
) {
  return createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => config,
    getPluginRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
}

function installChannel(
  gateway: ChannelPlugin["gateway"],
  config: Partial<ChannelPlugin["config"]> = {},
  id = "discord",
  runtimeConfig: OpenClawConfig = {},
) {
  const plugin = { ...createChannelTestPluginBase({ id, config }), gateway };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, plugin, source: "test" }]));
  return channelManager(requireActivePluginChannelRegistry, runtimeConfig);
}

function untilAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

let manager: ChannelManager | undefined;
afterEach(async () => {
  await manager?.stopChannel("discord");
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it("the config watcher restarts a channel that can save provider settings after reload closes", ({
  signal,
}) =>
  withOpenClawTestState({ label: "channel-reload-login" }, async (state) => {
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
    const reloadScheduled = createDeferred();
    const reloadClock = createGatewaySchedulerClock(Date.now());
    let starts = 0;
    const owner = installChannel(
      {
        startAccount: async ({ abortSignal }) => {
          const stopped = untilAborted(abortSignal);
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
      {},
      "telegram",
      initialConfig,
    );
    await owner.startChannel("telegram");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => restarted.reject(new Error(message))),
    };
    let assertReloadOwned: (() => void) | undefined;
    const reloader = startGatewayConfigReloader({
      scheduler: createTestGatewayScheduler({
        ...reloadClock.clock,
        arm: (run, delayMs) => {
          const cancel = reloadClock.clock.arm(run, delayMs);
          reloadScheduled.resolve();
          return cancel;
        },
      }),
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
        await reloadChannels(owner, plan.restartChannels, {
          log,
          recover: (surface) => {
            throw new Error(`unexpected restart recovery: ${surface}`);
          },
        });
        ownership.markRuntimeCommitted(next, plan);
        return "applied";
      },
      onRestart: () => {
        throw new Error("unexpected Gateway restart");
      },
      log,
    });
    try {
      await reloader.ready;
      await withTestTimeout(watcherReady.promise, 10_000, "config watcher did not start");
      await state.writeConfig({ ...initialConfig, commands: { ownerAllowFrom: ["telegram:2"] } });
      await withinTest(reloadScheduled.promise, signal);
      const reload = reloadClock.wake();
      await withTestTimeout(
        restarted.promise,
        10_000,
        "config watcher did not restart the channel",
      );
      await withinTest(Promise.resolve(reload), signal);
      expect(reloader.isReloading()).toBe(false);
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
  }));

it("retries failed teardown before admitting a replacement", async () => {
  const retryStarted = createDeferred();
  const finishTeardown = createDeferred();
  const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
    await untilAborted(abortSignal);
  });
  const stopAccount = vi
    .fn()
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("teardown failed"))
    .mockImplementationOnce(async () => {
      retryStarted.resolve();
      await finishTeardown.promise;
    });
  manager = installChannel(
    { startAccount, stopAccount },
    {
      listAccountIds: () => ["running"],
      resolveAccount: (_cfg, accountId) => ({ accountId }),
    },
  );
  await manager.startChannel("discord");
  await expect(manager.stopChannel("discord", undefined, { manual: false })).rejects.toThrow(
    "teardown failed",
  );
  await expect(manager.startChannel("discord")).resolves.toEqual(
    new Map([["running", { status: "retry", reason: "stop-in-flight" }]]),
  );

  const reload = reloadChannels(manager, new Set(["discord"]));
  try {
    await retryStarted.promise;
    expect(startAccount).toHaveBeenCalledOnce();
    finishTeardown.resolve();
    await reload;
    expect(stopAccount).toHaveBeenCalledTimes(2);
    expect(startAccount).toHaveBeenCalledTimes(2);
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
    manager = installChannel(
      {
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await untilAborted(abortSignal);
        },
      },
      {
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
    );
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
    const reload = reloadChannels(manager, channels, { accounts });
    if (state === "racing") {
      await configuring.promise;
      await manager.stopChannel("discord", "manual");
      blockConfiguration = false;
      releaseConfiguration.resolve();
    }
    await reload;
    expect(manager.isManuallyStopped("discord", "manual")).toBe(true);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(false);
    expect(starts).toEqual(state === "stopped" ? ["manual", "running"] : ["running"]);

    await manager.startChannel("discord", "manual", { manual: true });
    expect(manager.isManuallyStopped("discord", "manual")).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(true);
    expect(starts.at(-1)).toBe("manual");
  },
);
it("channel reload uses the attached registry instead of the process lookup", async () => {
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
              await untilAborted(abortSignal);
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
  const ownerA = channelManager(() => attached);
  const ownerB = channelManager(() => foreign);
  const stopOwnedChannels = async () => {
    for (const id of ownedIds) {
      await ownerA.stopChannel(id, undefined, { manual: false });
    }
  };
  try {
    for (const [name, next] of [
      ["A-original", attached],
      ["A-current", current],
    ] as const) {
      attached = next;
      setActivePluginRegistry(next);
      if (next === current) {
        registryOwnerA.publish(next);
      }
      const beforeStart = monitors.length;
      await ownerA.startChannels();
      expect(monitors.slice(beforeStart).map(({ owner }) => owner)).toEqual([name, name]);
      await stopOwnedChannels();
      expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);
    }

    setActivePluginRegistry(foreign);
    await ownerB.startChannels();
    const foreignMonitors = monitors.filter(({ owner }) => owner === "B");
    expect(foreignMonitors).toHaveLength(2);
    const beforeReload = monitors.length;
    await reloadChannels(ownerA, new Set(ownedIds), { registry: () => attached });
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
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);
  }
});
