import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  const onReplyStartSpy = vi.fn();
  const onCleanupSpy = vi.fn();
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy.mockReset();
    onCleanupSpy.mockReset();
    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });
  });

  afterEach(() => vi.useRealTimers());

  async function exerciseClosedController(closed: typeof controller) {
    await closed.onReplyStart();
    await closed.startTypingLoop();
    await closed.startTypingOnText("late text");
    closed.refreshTypingTtl();
    closed.markRunComplete();
    closed.markDispatchIdle();
    closed.cleanup();
    expect(closed.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("keeps typing alive while keepalive ticks continue during long runs", async () => {
    const longRunCleanupSpy = vi.fn();
    const longRunController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: longRunCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });

    await longRunController.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(115_000);
    expect(longRunCleanupSpy).not.toHaveBeenCalled();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(21);

    longRunController.cleanup();
    expect(longRunCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    vi.advanceTimersByTime(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it("keeps timer ticks behind an unfinished initial typing request", async () => {
    const pending = createDeferred();
    onReplyStartSpy.mockReturnValueOnce(pending.promise);

    await controller.startTypingLoop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    pending.resolve();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(2);
    controller.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cleanup", "run-first", "idle-first"] as const)(
    "disposes typing when %s closes the controller before start settles",
    async (completion) => {
      const starting = controller.startTypingLoop();
      if (completion === "cleanup") {
        controller.cleanup();
      } else if (completion === "run-first") {
        controller.markRunComplete();
        controller.markDispatchIdle();
      } else {
        controller.markDispatchIdle();
        controller.markRunComplete();
      }
      await starting;
      await exerciseClosedController(controller);
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("should prevent typing restart even if cleanup is delayed", async () => {
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Dispatch remains busy while three more keepalive intervals pass.
    controller.markRunComplete();
    for (let interval = 0; interval < 3; interval++) {
      vi.advanceTimersByTime(6000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    }
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an inert controller when typing callbacks are absent", async () => {
    await exerciseClosedController(createTypingController({}));
  });

  it("clamps an oversized typing interval and derives a longer TTL", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const boundedController = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: Number.MAX_SAFE_INTEGER,
      log: vi.fn(),
    });

    await boundedController.startTypingLoop();

    const maxTypingIntervalMs = Math.floor(MAX_TIMER_TIMEOUT_MS / 2);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), maxTypingIntervalMs * 2);
    boundedController.cleanup();
  });
});
