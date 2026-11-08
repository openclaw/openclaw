import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as backoff from "../infra/backoff.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { restartRunningChannelAccounts } from "./channel-thaw-restart.js";
import * as accountLifetime from "./server-channel-account-lifetime.js";
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
  it.each(["own-stop", "manual-stop", "replacement"] as const)(
    "binds a deferred thaw to its captured lifetime after %s",
    async (change) => {
      let open = change === "own-stop";
      const transport = new EventEmitter();
      let maxListeners = 0;
      const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContextV2<TestAccount>) => {
        const listener = () => {};
        transport.on("message", listener);
        maxListeners = Math.max(maxListeners, transport.listenerCount("message"));
        try {
          await waitForAbort(abortSignal);
        } finally {
          transport.off("message", listener);
        }
      });
      const registry = createTestChannelRegistry(
        createTestPlugin({
          startAccount,
          stopAccount: async () => {
            if (change === "own-stop") {
              open = false;
            }
          },
        }),
      );
      const manager = createTestChannelManager({ getPluginRegistry: () => registry });
      try {
        await manager.startChannels();
        const opts = { shouldContinue: () => open, onError: () => {} };
        const targets = await restartRunningChannelAccounts(manager, opts);
        expect(startAccount).toHaveBeenCalledOnce();
        if (change !== "own-stop") {
          await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
          if (change === "replacement") {
            await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
          }
        }
        open = true;
        expect(
          await restartRunningChannelAccounts(manager, opts, { kind: "deferred-retry", targets }),
        ).toEqual([]);
        expect(startAccount).toHaveBeenCalledTimes(change === "manual-stop" ? 1 : 2);
        expect(maxListeners).toBe(1);
        expect(transport.listenerCount("message")).toBe(change === "manual-stop" ? 0 : 1);
      } finally {
        await manager.stopChannel("discord");
      }
    },
  );

  it("joins a timed-out predecessor before completing deferred thaw recovery", async () => {
    const releaseTask = createDeferred();
    let active = 0;
    let peak = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (startAccount.mock.calls.length === 1) {
          await releaseTask.promise;
        } else {
          await waitForAbort(abortSignal);
        }
      } finally {
        active -= 1;
      }
    });
    const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    try {
      await manager.startChannels();
      const opts = { shouldContinue: () => true, onError: () => {} };
      const restartTask = restartRunningChannelAccounts(manager, opts);
      await vi.advanceTimersByTimeAsync(5_000);
      const targets = await restartTask;
      expect(targets).toHaveLength(1);
      expect(startAccount).toHaveBeenCalledOnce();
      releaseTask.resolve();
      await flushMicrotasks();
      expect(
        await restartRunningChannelAccounts(manager, opts, { kind: "deferred-retry", targets }),
      ).toEqual([]);
      expect(startAccount).toHaveBeenCalledTimes(2);
      expect(peak).toBe(1);
      expect(
        manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
      ).toMatchObject({ running: true, restartPending: false });
    } finally {
      releaseTask.resolve();
      await manager.stopChannel("discord");
    }
  });

  it.each(["exited-run abort", "manual stop", "recovery stop"] as const)(
    "settles restart backoff after %s",
    async (cause) => {
      const createLifetime = accountLifetime.createChannelAccountLifetime;
      const controllers: AbortController[] = [];
      const capture = vi
        .spyOn(accountLifetime, "createChannelAccountLifetime")
        .mockImplementation((...args) => {
          const lifetime = createLifetime(...args);
          controllers.push(lifetime.abort);
          return lifetime;
        });
      const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContextV2<TestAccount>) => {
        if (controllers.length > 1) {
          await waitForAbort(abortSignal);
        }
      });
      const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
      const manager = createTestChannelManager({ getPluginRegistry: () => registry });
      try {
        await manager.startChannels();
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
        if (cause === "exited-run abort") {
          controllers[0]?.abort();
        } else {
          await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
            manual: cause === "manual stop",
          });
        }
        await vi.advanceTimersByTimeAsync(6_000);
        const restarted = cause === "exited-run abort";
        expect(startAccount).toHaveBeenCalledTimes(restarted ? 2 : 1);
        expect(controllers[0]?.signal.aborted).toBe(true);
        expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
        expect(
          manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
        ).toMatchObject({ running: restarted, restartPending: false });
      } finally {
        await manager.stopChannel("discord");
        capture.mockRestore();
      }
    },
  );
  it("records a rejected restart wait and clears pending state", async () => {
    const startAccount = vi.fn(async () => {});
    const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    const wait = vi
      .spyOn(backoff, "sleepWithAbort")
      .mockRejectedValueOnce(new Error("restart wait failed"));
    try {
      await manager.startChannels();
      await vi.advanceTimersByTimeAsync(0);
      expect(startAccount).toHaveBeenCalledOnce();
      expect(
        manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
      ).toMatchObject({
        running: false,
        restartPending: false,
        lastError: "restart wait failed",
      });
      expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    } finally {
      await manager.stopChannel("discord");
      wait.mockRestore();
    }
  });
});
