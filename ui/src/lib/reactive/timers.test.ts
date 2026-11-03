import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createInterval, createTimeout } from "./timers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function clock<T>(create: (callback: () => void) => T) {
  const callback = vi.fn();
  const timer = createRoot((dispose) => ({ value: create(callback), dispose }));
  onTestFinished(timer.dispose);
  flush();
  return {
    ...timer,
    advance: (milliseconds: number, calls: number) => {
      vi.advanceTimersByTime(milliseconds);
      expect(callback).toHaveBeenCalledTimes(calls);
    },
  };
}

function reactiveTimer(createTimer: typeof createInterval, delay?: number) {
  const [source, setSource] = createSignal({ delay });
  const timer = clock((callback) => createTimer(callback, () => source().delay));
  return {
    ...timer,
    setDelay: (nextDelay?: number) => {
      setSource({ delay: nextDelay });
      flush();
    },
  };
}

it("keeps cadence across equal refreshes, changes delay, and stops on disposal", () => {
  const timer = reactiveTimer(createInterval, 100);
  timer.advance(50, 0);
  timer.setDelay(100);
  timer.advance(50, 1);
  timer.setDelay(200);
  timer.advance(199, 1);
  timer.advance(1, 2);
  timer.dispose();
  timer.advance(1000, 2);
});

it("pauses an interval while its reactive delay is absent", () => {
  const timer = reactiveTimer(createInterval);
  timer.advance(1000, 0);
  timer.setDelay(100);
  timer.advance(100, 1);
  timer.setDelay();
  timer.advance(1000, 1);
});

it("replaces pending deadlines, preserves the default delay, and cancels on disposal", () => {
  const { value: timer, dispose, advance } = clock((callback) => createTimeout(callback, 100));
  timer.schedule(200);
  advance(50, 0);
  timer.schedule(75);
  advance(50, 0);
  advance(25, 1);
  timer.schedule();
  advance(99, 1);
  advance(1, 2);
  timer.schedule();
  timer.cancel();
  advance(100, 2);
  timer.schedule();
  dispose();
  advance(100, 2);
});

it("preserves a reactive deadline across equal refreshes and cancels when paused or disposed", () => {
  const timer = reactiveTimer(createTimeout, 100);
  timer.advance(50, 0);
  timer.setDelay(100);
  timer.advance(50, 1);
  timer.advance(100, 1);

  timer.setDelay(200);
  timer.advance(100, 1);
  timer.setDelay(50);
  timer.advance(49, 1);
  timer.advance(1, 2);

  timer.setDelay(100);
  timer.setDelay();
  timer.advance(100, 2);
  timer.setDelay(100);
  timer.dispose();
  timer.advance(100, 2);
});
