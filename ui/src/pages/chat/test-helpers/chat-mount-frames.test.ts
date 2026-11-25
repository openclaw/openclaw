import { afterEach, expect, it, vi } from "vitest";
import { createFrameClock } from "../../../test-helpers/animation-frame-clock.ts";
import { settleChatMount } from "./chat-mount-frames.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("settles new mount work without draining prior callbacks or delayed timers", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = createFrameClock();
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
  const priorFrame = vi.fn();
  const priorTask = vi.fn();
  const delayedTask = vi.fn();
  const cancelledTask = vi.fn();
  requestAnimationFrame(priorFrame);
  setTimeout(priorTask, 0);
  const events: string[] = [];

  const value = settleChatMount(() => {
    requestAnimationFrame(() => {
      events.push("frame");
      setTimeout(() => events.push("task"), 0);
    });
    setTimeout(delayedTask, 10);
    const cancelled = setTimeout(cancelledTask, 0);
    clearTimeout(cancelled);
    return "mounted";
  });

  expect(value).toBe("mounted");
  expect(events).toEqual(["frame", "task"]);
  expect(priorFrame).not.toHaveBeenCalled();
  expect(priorTask).not.toHaveBeenCalled();
  expect(delayedTask).not.toHaveBeenCalled();
  expect(cancelledTask).not.toHaveBeenCalled();
  clock.flush(0);
  vi.advanceTimersByTime(10);
  expect(priorFrame).toHaveBeenCalledOnce();
  expect(priorTask).toHaveBeenCalledOnce();
  expect(delayedTask).toHaveBeenCalledOnce();
  expect(cancelledTask).not.toHaveBeenCalled();
});

it("restores native scheduling when mounting fails", () => {
  const before = [
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
    globalThis.setTimeout,
    globalThis.clearTimeout,
  ];
  expect(() =>
    settleChatMount(() => {
      throw new Error("mount failed");
    }),
  ).toThrow("mount failed");
  expect([
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
    globalThis.setTimeout,
    globalThis.clearTimeout,
  ]).toEqual(before);
});
