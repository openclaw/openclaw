import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Tests typing mode persistence across session updates and reply turns.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
      log: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
      await controller.onReplyStart();
      await controller.startTypingLoop();
      await controller.startTypingOnText("late text");
      controller.refreshTypingTtl();
      controller.markRunComplete();
      controller.markDispatchIdle();
      controller.cleanup();

      expect(controller.isActive()).toBe(false);
      expect(onCleanupSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("should prevent typing restart even if cleanup is delayed", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete (but dispatch not idle yet - simulating cleanup delay)
    controller.markRunComplete();

    // Multiple typing intervals should NOT restart typing
    vi.advanceTimersByTime(6000); // First interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Second interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Third interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an inert controller when typing callbacks are absent", async () => {
    const inert = createTypingController({});

    await inert.onReplyStart();
    await inert.startTypingLoop();
    await inert.startTypingOnText("hello");
    inert.refreshTypingTtl();
    inert.markRunComplete();
    inert.markDispatchIdle();
    inert.cleanup();

    expect(inert.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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
