import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyDispatcherWithTyping } from "./reply-dispatcher.js";
import { resolveTypingMode } from "./typing-mode.js";
import { createTypingController, runVisibleDeliveryTypingStart } from "./typing.js";

afterEach(() => vi.useRealTimers());

describe("visible delivery typing", () => {
  it("disables stream starts even with instant typing configured", () => {
    expect(
      resolveTypingMode({
        configured: "instant",
        isGroupChat: true,
        wasMentioned: false,
        typingStartPolicy: "visible_delivery",
      }),
    ).toBe("never");
  });

  it("starts once after the run and dispatcher have completed", async () => {
    const onReplyStart = vi.fn();
    const typing = createTypingController({ onReplyStart, keepalive: false });
    typing.markRunComplete();
    typing.markDispatchIdle();
    await typing.startTypingForVisibleDelivery();
    await typing.startTypingForVisibleDelivery();
    expect(onReplyStart).toHaveBeenCalledOnce();
    typing.cleanup();
  });

  it("seals typing when delivery settles before the run completes", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn();
    const typing = createTypingController({ onReplyStart });
    typing.markDispatchIdle();
    await typing.startTypingForVisibleDelivery();
    typing.markRunComplete();
    await typing.startTypingForVisibleDelivery();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onReplyStart).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("honors typing suppression (%s) at delivery", async (suppressTyping) => {
    const onReplyStart = vi.fn();
    const lifecycle = createReplyDispatcherWithTyping({
      deliver: async () => undefined,
      typingStartPolicy: "visible_delivery",
      suppressTyping,
      onReplyStart,
    });
    await lifecycle.replyOptions.onVisibleDeliveryStart?.();
    await lifecycle.replyOptions.onVisibleDeliveryStart?.();
    expect(onReplyStart).toHaveBeenCalledTimes(suppressTyping ? 0 : 1);
    lifecycle.dispatcher.markComplete();
    await lifecycle.dispatcher.waitForIdle();
  });

  it("cleans up a timed-out start and its late completion", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    const stop = vi.fn();
    const run = runVisibleDeliveryTypingStart({
      start: () => pending.promise,
      timeoutMs: 1_000,
      onTimeout: stop,
      onLateCompletion: stop,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(stop).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("cleans up a platform start that finishes after controller cleanup", async () => {
    const pending = createDeferred();
    const onReplyStart = vi.fn(() => pending.promise);
    const onCleanup = vi.fn();
    const typing = createTypingController({ onReplyStart, onCleanup, keepalive: false });
    const start = typing.startTypingForVisibleDelivery();
    typing.cleanup();
    expect(onCleanup).toHaveBeenCalledOnce();
    pending.resolve();
    await start;
    expect(onCleanup).toHaveBeenCalledTimes(2);
    expect(typing.isActive()).toBe(false);
  });
});
