import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginHookMessageSendingResult } from "./hook-message.types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const demoChannelCtx = { channelId: "demo-channel" };
const original = { to: "user-123", content: "original content" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("message_sending hook runner", () => {
  it.each([
    {
      name: "runMessageSending invokes registered hooks and returns modified content",
      event: { to: "user-123", content: "original content" },
      hookResult: { content: "modified content" },
    },
    {
      name: "runMessageSending can cancel message delivery",
      event: { to: "user-123", content: "blocked" },
      hookResult: { cancel: true, cancelReason: "policy", metadata: { owner: "agent-2" } },
    },
  ] as const)("$name", async ({ event, hookResult }) => {
    const handler = vi.fn().mockReturnValue(hookResult);
    const { runner } = createHookRunnerWithRegistry([{ hookName: "message_sending", handler }]);
    await expect(runner.runMessageSending(event, demoChannelCtx)).resolves.toEqual(hookResult);
    expect(handler).toHaveBeenCalledWith(event, demoChannelCtx);
  });

  it("fails open after the default per-handler timeout", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const firstStarted = createDeferred();
    const first = vi.fn(() => {
      firstStarted.resolve();
      return new Promise<PluginHookMessageSendingResult>(() => {});
    });
    const second = vi.fn().mockResolvedValue({ content: "after timeout" });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "message_sending", handler: first },
        { hookName: "message_sending", handler: second },
      ],
      { logger },
    );

    const resultPromise = runner.runMessageSending(original, demoChannelCtx);
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({ content: "after timeout" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] message_sending handler from test-plugin failed: timed out after 15000ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a handler-specific timeout longer than the default", async () => {
    const handler = vi.fn(
      () =>
        new Promise<PluginHookMessageSendingResult>((resolve) => {
          setTimeout(() => resolve({ content: "slow result" }), 16_000);
        }),
    );
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "message_sending", handler, timeoutMs: 20_000 },
    ]);
    const resultPromise = runner.runMessageSending(original, demoChannelCtx);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(resultPromise).resolves.toEqual({ content: "slow result" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("message_sent hook runner", () => {
  it.each([
    {
      name: "runMessageSent invokes registered hooks with success=true",
      event: { to: "user-123", content: "hello", success: true },
    },
    {
      name: "runMessageSent invokes registered hooks with error on failure",
      event: { to: "user-123", content: "hello", success: false, error: "timeout" },
    },
  ] as const)("$name", async ({ event }) => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "message_sent", handler }]);
    await runner.runMessageSent(event, demoChannelCtx);
    expect(handler).toHaveBeenCalledWith(event, demoChannelCtx);
  });
});
