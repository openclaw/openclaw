import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createTestPlugin,
  flushMicrotasks,
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
  function suppressedManager(
    options: Parameters<typeof createManager>[0],
    start: typeof stayRunning = async () => {},
  ) {
    const startAccount = vi.fn(start);
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(options);
    const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
    manager.setAutostartSuppression(suppression);
    return { manager, startAccount, suppression };
  }
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
        const { manager, startAccount } = suppressedManager(
          { tryRecoverAutostartSuppression: async () => undefined },
          stayRunning,
        );

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
        createTestPlugin({ startAccount, listAccountIds: () => [DEFAULT_ACCOUNT_ID, "work"] }),
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
      const { manager, startAccount, suppression } = suppressedManager({
        scheduler,
        tryRecoverAutostartSuppression: tryRecover,
      });

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
      let closing = false;
      const { manager, startAccount } = suppressedManager({
        deferStartupAccountStartsUntil: accountStartReady.promise,
        isClosing: () => closing,
        tryRecoverAutostartSuppression: async () => undefined,
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
        const deadline = Date.now() + 10_000;
        const failure = new Error("Crash-loop recovery did not commit");
        const { manager, startAccount, suppression } = suppressedManager({
          tryRecoverAutostartSuppression: async () => {
            if (result === "failed") {
              throw failure;
            }
            return deadline;
          },
        });

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
        let closing = false;
        const { manager, startAccount, suppression } = suppressedManager({
          isClosing: () => closing,
          tryRecoverAutostartSuppression: () => transition.promise,
        });

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
