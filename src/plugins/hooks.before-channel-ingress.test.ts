import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginHookBeforeChannelIngressContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";

function context(controller = new AbortController()): PluginHookBeforeChannelIngressContext {
  return {
    channelId: "telegram",
    accountId: "account-a",
    abortSignal: controller.signal,
    heartbeat: vi.fn(),
    heartbeatIntervalMs: 100_000,
  };
}

describe("before_channel_ingress lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("fails closed instead of skipping a failed preparation gate", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          handler: async () => {
            throw new Error("not ready");
          },
        },
      ]),
    );
    await expect(runner.runBeforeChannelIngress({ providerUpdate: {} }, context())).rejects.toThrow(
      "not ready",
    );
  });

  it("expires each heartbeat before invoking the next handler", async () => {
    let retainedHeartbeat: (() => void) | undefined;
    const ctx = context();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          priority: 100,
          handler: async (_event, hookContext) => {
            const scope = hookContext as PluginHookBeforeChannelIngressContext;
            retainedHeartbeat = scope.heartbeat;
            scope.heartbeat();
          },
        },
        {
          hookName: "before_channel_ingress",
          priority: 0,
          handler: async () => {
            expect(retainedHeartbeat).toBeDefined();
            expect(() => retainedHeartbeat?.()).toThrow("no longer active");
            return { text: "Prepared", suppressAttachments: true };
          },
        },
      ]),
    );
    await expect(runner.runBeforeChannelIngress({ providerUpdate: {} }, ctx)).resolves.toEqual({
      text: "Prepared",
      suppressAttachments: true,
    });
    expect(ctx.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("closes pending preparation immediately on native cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const pending = createDeferred();
    const started = createDeferred();
    let heartbeat: (() => void) | undefined;
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          timeoutMs: 600_000,
          handler: async (_event, hookContext) => {
            heartbeat = (hookContext as PluginHookBeforeChannelIngressContext).heartbeat;
            started.resolve();
            await pending.promise;
            return { text: "Late" };
          },
        },
      ]),
    );
    const preparation = runner.runBeforeChannelIngress({ providerUpdate: {} }, context(controller));
    await started.promise;
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(new Error("shutdown"));
    await expect(preparation).rejects.toThrow("Operation aborted");
    expect(() => heartbeat?.()).toThrow("no longer active");
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve();
  });

  it("expires a timed-out handler signal and heartbeat without dispatching late output", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = createDeferred();
    let retained: PluginHookBeforeChannelIngressContext | undefined;
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          timeoutMs: 10,
          handler: async (_event, hookContext) => {
            retained = hookContext as PluginHookBeforeChannelIngressContext;
            await pending.promise;
            return { text: "Late" };
          },
        },
      ]),
    );
    const preparation = runner.runBeforeChannelIngress({ providerUpdate: {} }, context());
    const failure = expect(preparation).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(retained?.abortSignal.aborted).toBe(true);
    expect(() => retained?.heartbeat()).toThrow("no longer active");
    pending.resolve();
  });
});
