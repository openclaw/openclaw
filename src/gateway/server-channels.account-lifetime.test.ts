import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createTestPlugin,
  createTestChannelRegistry,
  createTestChannelManager,
  waitForAbort,
  flushMicrotasks,
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
