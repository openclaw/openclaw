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
