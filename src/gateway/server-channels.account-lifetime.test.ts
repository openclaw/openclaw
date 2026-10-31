import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  captureThawRestartTargets,
  restartRunningChannelAccounts,
} from "./channel-thaw-restart.js";
import {
  createTestPlugin,
  createTestChannelRegistry,
  createTestChannelManager,
  waitForAbort,
  flushMicrotasks,
  waitForMicrotaskCondition,
  type TestAccount,
} from "./server-channels.test-support.js";

describe("channel account scheduling lifetime", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  it("stops thaw restarts once admission closes mid-pass", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const plugin = createTestPlugin({
      listAccountIds: () => ["first", "second"],
      startAccount: async (context) => {
        starts.push(context.accountId);
        await waitForAbort(context.abortSignal);
      },
      stopAccount: async (context) => {
        stops.push(context.accountId);
      },
    });
    const registry = createTestChannelRegistry(plugin);
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    try {
      await manager.startChannels();
      await vi.waitFor(() => expect(starts).toHaveLength(2));
      starts.length = 0;
      stops.length = 0;

      let open = true;
      const pending = await restartRunningChannelAccounts(captureThawRestartTargets(manager), {
        shouldContinue: () => {
          if (stops.length > 0) {
            // Simulate a suspension committing while the first stop was awaited.
            open = false;
          }
          return open;
        },
        onError: () => {},
      });

      expect(stops).toEqual(["first"]);
      expect(starts).toEqual([]);
      expect(
        await restartRunningChannelAccounts(pending, {
          shouldContinue: () => true,
          onError: () => {},
        }),
      ).toEqual([]);
      expect(starts).toEqual(["first", "second"]);
      expect(stops).toEqual(["first", "second"]);
    } finally {
      await manager.stopChannel("discord");
    }
  });

  it("logs the account retry reason when another stop overtakes thaw replacement", async () => {
    const releaseStop = createDeferred();
    let stopCount = 0;
    const startAccount = vi.fn(async (context: ChannelGatewayContextV2<TestAccount>) => {
      context.setStatus({ accountId: context.accountId, lastError: "transport disconnected" });
      await waitForAbort(context.abortSignal);
    });
    const plugin = createTestPlugin({
      startAccount,
      stopAccount: async () => {
        if (++stopCount === 2) {
          await releaseStop.promise;
        }
      },
    });
    const registry = createTestChannelRegistry(plugin);
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    await manager.startChannels();
    const warn = vi.spyOn(startAccount.mock.calls[0]![0].log!, "warn");
    const restart = manager.captureAccountRestart("discord", DEFAULT_ACCOUNT_ID, "host-thaw");
    let checks = 0;
    let overtakingStop: Promise<void> | undefined;
    try {
      expect(
        await restart!(() => {
          if (++checks === 2) {
            overtakingStop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
          }
          return true;
        }),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[default] host-thaw restart failed: replacement was not handed off (stop-in-flight): transport disconnected",
      );
      expect(startAccount).toHaveBeenCalledOnce();
    } finally {
      releaseStop.resolve();
      await overtakingStop;
      warn.mockRestore();
      await manager.stopChannel("discord");
    }
  });

  it.each([false, true])(
    "retains thaw recovery after late task cleanup with foreign replacement=%s",
    async (replaced) => {
      const releaseTask = createDeferred();
      const signals: AbortSignal[] = [];
      const stopAccount = vi.fn(async () => {});
      const plugin = createTestPlugin({
        startAccount: async ({ abortSignal }) => {
          signals.push(abortSignal);
          await (signals.length === 1 ? releaseTask.promise : waitForAbort(abortSignal));
        },
        stopAccount,
      });
      const registry = createTestChannelRegistry(plugin);
      const manager = createTestChannelManager({ getPluginRegistry: () => registry });
      let restarting: Promise<boolean> | undefined;
      try {
        await manager.startChannels();
        const restart = manager.captureAccountRestart("discord", DEFAULT_ACCOUNT_ID, "host-thaw")!;
        let checks = 0;
        restarting = restart(() => ++checks === 1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await restarting).toBe(false);
        expect(stopAccount).toHaveBeenCalledOnce();
        expect(signals[0]?.aborted).toBe(true);

        releaseTask.resolve();
        await waitForMicrotaskCondition(
          () =>
            manager.captureAccountRestart("discord", DEFAULT_ACCOUNT_ID, "host-thaw") === undefined,
          "expected late timeout cleanup to release the stopped lifetime",
        );
        expect(signals).toHaveLength(1);
        if (replaced) {
          await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { reason: "health-monitor" });
        }

        expect(await restart(() => true)).toBe(true);
        expect(signals).toHaveLength(2);
        expect(signals[1]?.aborted).toBe(false);
        expect(stopAccount).toHaveBeenCalledOnce();
      } finally {
        releaseTask.resolve();
        await restarting;
        await manager.stopChannel("discord");
      }
    },
  );

  it.each(["accounts", "channels"] as const)(
    "starts healthy %s independently of pending database preparation",
    async (scope) => {
      const preparation = createDeferred();
      const started: string[] = [];
      const makePlugin = (id: string, order: number, accountIds: string[]) => {
        const plugin = createTestPlugin({
          id,
          order,
          listAccountIds: () => accountIds,
          startAccount: async ({ accountId, abortSignal }) => {
            started.push(`${id}/${accountId}`);
            await waitForAbort(abortSignal);
          },
        });
        plugin.config.resolveAccountAsync = async (_cfg, accountId) => {
          if (accountId !== "ready") {
            await preparation.promise;
          }
          return { enabled: true, configured: true };
        };
        return plugin;
      };
      const plugins =
        scope === "accounts"
          ? [
              makePlugin("discord", 0, [
                "pending-1",
                "pending-2",
                "pending-3",
                "pending-4",
                "ready",
              ]),
            ]
          : [
              ...Array.from({ length: 4 }, (_, index) =>
                makePlugin(`pending-${index}`, index, ["pending"]),
              ),
              makePlugin("discord", 4, ["ready"]),
            ];
      const registry = createTestChannelRegistry(...plugins);
      const manager = createTestChannelManager({
        getPluginRegistry: () => registry,
        startupTrace: { measure: async (_name, run) => await run() },
      });
      const starting = manager.startChannels();
      try {
        // Startup handoff yields to the event loop; preparation remains unresolved.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(started).toEqual(["discord/ready"]);
        preparation.resolve();
        await starting;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(started).toHaveLength(5);
      } finally {
        preparation.resolve();
        await starting;
        await Promise.all(plugins.map((plugin) => manager.stopChannel(plugin.id)));
      }
    },
  );

  it("retains timed-out idle cleanup after the account is disabled", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const stopAccount = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    let config: OpenClawConfig = { channels: { discord: { enabled: true } } };
    const registry = createTestChannelRegistry(
      createTestPlugin({
        startAccount: ({ abortSignal }) => waitForAbort(abortSignal),
        stopAccount,
      }),
    );
    const manager = createTestChannelManager({
      getRuntimeConfig: () => config,
      getPluginRegistry: () => registry,
    });
    const firstStop = manager
      .stopChannel("discord", DEFAULT_ACCOUNT_ID)
      .catch((error: unknown) => error);
    let secondStop: Promise<void> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await firstStop).toBeInstanceOf(Error);
      config = { channels: { discord: { enabled: false } } };
      let settled = false;
      secondStop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID).then(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(stopAccount).toHaveBeenCalledOnce();
      config = { channels: { discord: { enabled: true } } };
      expect(await manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).toEqual(
        new Map([[DEFAULT_ACCOUNT_ID, { status: "retry", reason: "stop-in-flight" }]]),
      );
      release.resolve();
      await secondStop;
      expect(settled).toBe(true);
      expect(stopAccount).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await firstStop;
      await secondStop;
      await manager.stopChannel("discord");
    }
  });

  it("retains account capabilities until admitted scheduled I/O settles", async () => {
    const clock = createGatewaySchedulerClock();
    const io = createDeferred();
    const entered = createDeferred();
    let committed = false;
    let account: ChannelGatewayContextV2<TestAccount> | undefined;
    const registerRoute = (path: string) =>
      registerPluginHttpRoute({
        path,
        auth: "plugin",
        handler: async () => true,
        pluginId: "discord",
        throwOnFailure: true,
      });
    const registry = createTestChannelRegistry(
      createTestPlugin({
        startAccount: async (context) => {
          account = context;
          context.scheduler.schedule({
            id: "settlement",
            delayMs: 1,
            run: async () => {
              registerRoute("/account-before-io");
              entered.resolve();
              await io.promise;
              registerRoute("/account-after-io");
              committed = true;
            },
          });
          await waitForAbort(context.abortSignal);
        },
      }),
    );
    const manager = createTestChannelManager({
      getPluginRegistry: () => registry,
      scheduler: createTestGatewayScheduler(clock.clock),
    });
    let ticking: ReturnType<typeof clock.advanceBy> = undefined;
    let stopping: Promise<void> | undefined;
    try {
      await manager.startChannels();
      await flushMicrotasks();
      ticking = clock.advanceBy(1);
      await entered.promise;
      let stopped = false;
      stopping = manager.stopChannel("discord").then(() => {
        stopped = true;
      });
      await flushMicrotasks();
      expect(account?.scheduler.signal.aborted).toBe(true);
      expect(stopped).toBe(false);
      expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/account-before-io"]);
      expect(() => account?.scheduler.schedule({ id: "late", delayMs: 0, run: () => {} })).toThrow(
        "closed",
      );
      io.resolve();
      await Promise.all([ticking, stopping]);
      expect(committed).toBe(true);
      expect(registry.httpRoutes).toHaveLength(0);
    } finally {
      io.resolve();
      await ticking;
      await stopping;
      await manager.stopChannel("discord");
    }
  });

  it("joins account scheduled work at retirement without stopping a sibling", async ({
    signal,
  }) => {
    const clock = createGatewaySchedulerClock();
    const siblingRearmed = createDeferred();
    const work = createDeferred();
    const contexts = new Map<string, ChannelGatewayContextV2<TestAccount>>();
    const ran = vi.fn<(accountId: string) => void>();
    const stopAccount = vi.fn(async () => {});
    const registry = createTestChannelRegistry(
      createTestPlugin({
        listAccountIds: () => ["first", "second"],
        startAccount: async (context) => {
          contexts.set(context.accountId, context);
          context.scheduler.schedule({
            id: "poll",
            delayMs: 10,
            everyMs: 10,
            run: async () => {
              ran(context.accountId);
              if (context.accountId === "first") {
                await work.promise;
              }
            },
          });
          await waitForAbort(context.abortSignal);
        },
        stopAccount,
      }),
    );
    const manager = createTestChannelManager({
      getPluginRegistry: () => registry,
      scheduler: createTestGatewayScheduler({
        ...clock.clock,
        arm(run, delayMs) {
          const cancel = clock.clock.arm(run, delayMs);
          if (clock.armedAtMs === 20) {
            siblingRearmed.resolve();
          }
          return cancel;
        },
      }),
    });
    let running: ReturnType<typeof clock.advanceBy> = undefined;
    let stopping: Promise<void> | undefined;
    try {
      await manager.startChannels();
      await flushMicrotasks();
      running = clock.advanceBy(10);
      expect(ran.mock.calls).toEqual([["first"], ["second"]]);
      let stopped = false;
      stopping = manager.stopChannel("discord", "first").then(() => {
        stopped = true;
      });
      await flushMicrotasks();
      expect(contexts.get("first")?.scheduler.signal.aborted).toBe(true);
      expect(contexts.get("second")?.scheduler.signal.aborted).toBe(false);
      expect(stopAccount).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      await withinTest(siblingRearmed.promise, signal);
      await clock.advanceBy(10);
      expect(ran.mock.calls).toEqual([["first"], ["second"], ["second"]]);
      work.resolve();
      await Promise.all([running, stopping]);
      expect(stopAccount).toHaveBeenCalledOnce();
      expect(() =>
        contexts.get("first")?.scheduler.schedule({
          id: "late",
          delayMs: 0,
          run: () => ran("late"),
        }),
      ).toThrow("closed");
      await clock.advanceBy(10);
      expect(ran.mock.calls).toEqual([["first"], ["second"], ["second"], ["second"]]);
      await manager.stopChannel("discord", "second");
    } finally {
      work.resolve();
      await Promise.allSettled([running, stopping]);
      await manager.stopChannel("discord");
    }
  });

  it.each([true, false])("retains timed-out ordinary cleanup with manual=%s", async (manual) => {
    const entered = createDeferred();
    const release = createDeferred();
    const startAccount = vi.fn(({ abortSignal }: ChannelGatewayContextV2<TestAccount>) =>
      waitForAbort(abortSignal),
    );
    const stopAccount = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const registry = createTestChannelRegistry(createTestPlugin({ startAccount, stopAccount }));
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    let firstStop: Promise<unknown> | undefined;
    let secondStop: Promise<void> | undefined;
    try {
      await manager.startChannels();
      await flushMicrotasks();
      firstStop = manager
        .stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual })
        .catch((error: unknown) => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await firstStop).toBeInstanceOf(Error);
      expect(
        manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.lastError,
      ).toContain("stopAccount did not settle");
      expect(await manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).toEqual(
        new Map([[DEFAULT_ACCOUNT_ID, { status: "retry", reason: "stop-in-flight" }]]),
      );
      let secondSettled = false;
      secondStop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual }).then(() => {
        secondSettled = true;
      });
      await flushMicrotasks();
      expect(secondSettled).toBe(false);
      expect(stopAccount).toHaveBeenCalledOnce();
      expect(startAccount).toHaveBeenCalledOnce();
      release.resolve();
      await secondStop;
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      await flushMicrotasks();
      expect(startAccount).toHaveBeenCalledTimes(2);
      expect(stopAccount).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await firstStop;
      await secondStop;
      await manager.stopChannel("discord");
    }
  });
});
