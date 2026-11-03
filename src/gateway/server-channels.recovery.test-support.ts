import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { channelReadyPatch } from "./channel-status-patches.js";
import * as accountLifetime from "./server-channel-account-lifetime.js";
import {
  createTestPlugin,
  flushMicrotasks,
  waitForMicrotaskCondition,
  type createTestChannelManager,
  type createTestChannelRegistry,
  type TestAccount,
} from "./server-channels.test-support.js";

export function registerChannelAutostartRecoveryTests({
  createManager,
  installTestRegistry,
  stayRunning,
}: {
  createManager: typeof createTestChannelManager;
  installTestRegistry: typeof createTestChannelRegistry;
  stayRunning: (context: ChannelGatewayContext<TestAccount>) => Promise<void>;
}): void {
  it.each(["exited-run abort", "manual stop", "recovery stop"] as const)(
    "settles restart backoff after %s",
    async (cause) => {
      const createLifetime = accountLifetime.createChannelAccountLifetime;
      const controllers: AbortController[] = [];
      const captureLifetime = vi
        .spyOn(accountLifetime, "createChannelAccountLifetime")
        .mockImplementation((...args) => {
          const lifetime = createLifetime(...args);
          controllers.push(lifetime.abort);
          return lifetime;
        });
      const startAccount = vi.fn(async (context: ChannelGatewayContext<TestAccount>) => {
        if (controllers.length === 1) {
          return;
        }
        context.setStatus(channelReadyPatch({ accountId: context.accountId }));
        await stayRunning(context);
      });
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager();

      try {
        await manager.startChannels();
        await waitForMicrotaskCondition(
          () => manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID),
          "expected provider exit to schedule restart backoff",
        );
        expect(
          manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]
            ?.restartPending,
        ).toBe(true);
        const exitedRun = controllers[0];
        if (!exitedRun) {
          throw new Error("expected the exited account's abort controller");
        }
        if (cause === "exited-run abort") {
          exitedRun.abort();
        } else {
          await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
            manual: cause === "manual stop",
          });
        }

        await vi.advanceTimersByTimeAsync(200);
        const restarted = cause === "exited-run abort";
        expect(startAccount).toHaveBeenCalledTimes(restarted ? 2 : 1);
        expect(exitedRun.signal.aborted).toBe(true);
        expect(
          manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
        ).toMatchObject({
          running: restarted,
          restartPending: false,
        });
        expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
      } finally {
        captureLifetime.mockRestore();
      }
    },
  );

  it("records a rejected restart wait and clears pending state", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    vi.mocked(sleepWithAbort).mockRejectedValueOnce(new Error("restart wait failed"));

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID],
    ).toMatchObject({
      running: false,
      lifecycle: "stopped",
      restartPending: false,
      lastError: "restart wait failed",
    });
    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  describe("crash-loop channel autostart recovery", () => {
    let originalEnv: ReturnType<typeof captureEnv>;
    beforeEach(() => {
      originalEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
      deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
      deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
    });
    afterEach(() => originalEnv.restore());

    it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
      "preserves %s suppression after breaker recovery while allowing manual starts",
      async (envKey) => {
        setTestEnvValue(envKey, "1");
        const startAccount = vi.fn(stayRunning);
        installTestRegistry(createTestPlugin({ startAccount }));
        const manager = createManager({ tryRecoverAutostartSuppression: async () => undefined });
        manager.setAutostartSuppression({ reason: "crash-loop-breaker", message: "safe mode" });

        await expect(manager.recoverAutostartSuppression()).resolves.toBeUndefined();
        expect(manager.getAutostartSuppression()).toBeNull();
        expect(startAccount).not.toHaveBeenCalled();

        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
        expect(startAccount).toHaveBeenCalledOnce();
      },
    );
    it("joins autostart recovery after a waiter cancels without undoing manual stops", async () => {
      const startAccount = vi.fn(stayRunning);
      installTestRegistry(
        createTestPlugin({
          startAccount,
          listAccountIds: () => [DEFAULT_ACCOUNT_ID, "work"],
        }),
      );
      const transition = createDeferred<number | undefined>();
      const tryRecover = vi.fn(() => transition.promise);
      const manager = createManager({
        tryRecoverAutostartSuppression: tryRecover,
        getRuntimeConfig: () => ({
          channels: { discord: { healthMonitor: { enabled: false } } },
        }),
      });
      manager.setAutostartSuppression({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      await manager.startChannels();
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      const waiter = new AbortController();
      const recovery = manager.recoverAutostartSuppression(waiter.signal);
      const concurrentRecovery = manager.recoverAutostartSuppression();
      await flushMicrotasks();
      expect(manager.getAutostartSuppression()).not.toBeNull();
      expect(startAccount).toHaveBeenCalledTimes(1);
      const cancellation = expect(recovery).rejects.toMatchObject({ name: "AbortError" });
      waiter.abort();
      transition.resolve(undefined);
      await cancellation;
      await expect(concurrentRecovery).resolves.toBeUndefined();
      await flushMicrotasks();

      expect(tryRecover).toHaveBeenCalledOnce();
      expect(manager.getAutostartSuppression()).toBeNull();
      expect(startAccount.mock.calls.map(([ctx]) => ctx.accountId)).toEqual([
        DEFAULT_ACCOUNT_ID,
        "work",
      ]);
      expect(manager.isHealthMonitorEnabled("discord", "work")).toBe(false);
      expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
      expect(manager.recoverAutostartSuppression()).toBeUndefined();
      expect(tryRecover).toHaveBeenCalledOnce();
    });

    it("retires the breaker error on accounts that stay unlinked after recovery", async () => {
      installTestRegistry(
        createTestPlugin({
          startAccount: vi.fn(stayRunning),
          isLinked: () => "not-linked",
          listAccountIds: () => [DEFAULT_ACCOUNT_ID, "work"],
        }),
      );
      const manager = createManager({ tryRecoverAutostartSuppression: async () => undefined });
      manager.setAutostartSuppression({ reason: "crash-loop-breaker", message: "safe mode" });
      await manager.startChannels();
      manager.markChannelLoggedOut("discord", true, "work");
      const lastErrors = () =>
        Object.fromEntries(
          Object.entries(manager.getRuntimeSnapshot().channelAccounts.discord ?? {}).map(
            ([id, account]) => [id, account.lastError],
          ),
        );
      expect(lastErrors()).toEqual({ [DEFAULT_ACCOUNT_ID]: "safe mode", work: "logged out" });

      await manager.recoverAutostartSuppression();

      expect(lastErrors()).toEqual({ [DEFAULT_ACCOUNT_ID]: null, work: "logged out" });
    });

    it("prepares a healthy boot synchronously without reading the breaker owner", () => {
      const tryRecover = vi.fn(async () => undefined);
      const manager = createManager({ tryRecoverAutostartSuppression: tryRecover });

      expect(manager.recoverAutostartSuppression()).toBeUndefined();
      expect(tryRecover).not.toHaveBeenCalled();
    });

    it("aborts an active breaker read at scheduler close prelude without starting another", async () => {
      const scheduler = createTestGatewayScheduler();
      const tryRecover = vi.fn(async (signal: AbortSignal) => {
        await waitForAbortSignal(signal);
        return undefined;
      });
      const startAccount = vi.fn(async () => {});
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager({ scheduler, tryRecoverAutostartSuppression: tryRecover });
      const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
      manager.setAutostartSuppression(suppression);

      const recovery = manager.recoverAutostartSuppression();
      const failure = Promise.resolve(recovery).catch((error: unknown) => error);
      scheduler.beginClose();
      expect(await failure).toBe(scheduler.signal.reason);

      expect(() => manager.recoverAutostartSuppression()).toThrow(scheduler.signal.reason);
      expect(tryRecover).toHaveBeenCalledOnce();
      expect(tryRecover.mock.calls[0]?.[0]?.aborted).toBe(true);
      expect(manager.getAutostartSuppression()).toBe(suppression);
      expect(startAccount).not.toHaveBeenCalled();
    });

    it("does not start recovered accounts after gateway close begins during handoff", async () => {
      const accountStartReady = createDeferred();
      const startAccount = vi.fn(async () => {});
      let closing = false;
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager({
        deferStartupAccountStartsUntil: accountStartReady.promise,
        isClosing: () => closing,
        tryRecoverAutostartSuppression: async () => undefined,
      });
      manager.setAutostartSuppression({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      const recovery = manager.recoverAutostartSuppression();
      await flushMicrotasks();
      closing = true;
      accountStartReady.resolve();
      await recovery;
      await flushMicrotasks();

      expect(manager.getAutostartSuppression()).toBeNull();
      expect(startAccount).not.toHaveBeenCalled();
    });

    it.each(["paused", "failed"] as const)(
      "keeps suppression when the breaker owner reports %s recovery",
      async (result) => {
        const startAccount = vi.fn(async () => {});
        const deadline = Date.now() + 10_000;
        const failure = new Error("Crash-loop recovery did not commit");
        installTestRegistry(createTestPlugin({ startAccount }));
        const manager = createManager({
          tryRecoverAutostartSuppression: async () => {
            if (result === "failed") {
              throw failure;
            }
            return deadline;
          },
        });
        const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
        manager.setAutostartSuppression(suppression);

        const recovery = manager.recoverAutostartSuppression();
        if (result === "paused") {
          await expect(recovery).resolves.toBe(deadline);
        } else {
          await expect(recovery).rejects.toBe(failure);
        }

        expect(manager.getAutostartSuppression()).toBe(suppression);
        expect(startAccount).not.toHaveBeenCalled();
      },
    );

    it.each(["closing", "replacement"] as const)(
      "keeps suppression when %s overtakes the persisted recovery transition",
      async (change) => {
        const transition = createDeferred<number | undefined>();
        const startAccount = vi.fn(async () => {});
        let closing = false;
        installTestRegistry(createTestPlugin({ startAccount }));
        const manager = createManager({
          isClosing: () => closing,
          tryRecoverAutostartSuppression: () => transition.promise,
        });
        const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
        manager.setAutostartSuppression(suppression);

        const recovery = manager.recoverAutostartSuppression();
        const current = change === "replacement" ? { ...suppression } : suppression;
        manager.setAutostartSuppression(current);
        closing = change === "closing";
        transition.resolve(undefined);

        await expect(recovery).rejects.toThrow("owner changed");
        expect(manager.getAutostartSuppression()).toBe(current);
        expect(startAccount).not.toHaveBeenCalled();
      },
    );
  });
}
