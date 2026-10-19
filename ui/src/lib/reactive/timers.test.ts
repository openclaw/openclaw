import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createInterval, createTimeout } from "./timers.ts";

afterEach(() => vi.useRealTimers());

it("keeps cadence across equal refreshes, pauses, changes delay, and stops on disposal", () => {
  vi.useFakeTimers();
  const tick = vi.fn();
  const [source, setSource] = createSignal({ delay: 100 });
  const dispose = createRoot((stop) => {
    createInterval(tick, () => source().delay);
    return stop;
  });
  onTestFinished(dispose);
  flush();
  vi.advanceTimersByTime(50);
  setSource({ delay: 100 });
  flush();
  vi.advanceTimersByTime(50);
  expect(tick).toHaveBeenCalledTimes(1);
  setSource({ delay: 200 });
  flush();
  vi.advanceTimersByTime(199);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(2);
  dispose();
  vi.advanceTimersByTime(1000);
  expect(tick).toHaveBeenCalledTimes(2);
});

it("pauses an interval while its reactive delay is absent", () => {
  vi.useFakeTimers();
  const tick = vi.fn();
  const [delay, setDelay] = createSignal<number>();
  const dispose = createRoot((stop) => {
    createInterval(tick, delay);
    return stop;
  });
  onTestFinished(dispose);
  flush();
  vi.advanceTimersByTime(1000);
  expect(tick).not.toHaveBeenCalled();
  setDelay(100);
  flush();
  vi.advanceTimersByTime(100);
  expect(tick).toHaveBeenCalledTimes(1);
  setDelay(undefined);
  flush();
  vi.advanceTimersByTime(1000);
  expect(tick).toHaveBeenCalledTimes(1);
});

it("replaces pending deadlines, preserves the default delay, and cancels on disposal", () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const { timer, dispose } = createRoot((stop) => ({
    timer: createTimeout(callback, 100),
    dispose: stop,
  }));
  onTestFinished(dispose);
  timer.schedule(200);
  vi.advanceTimersByTime(50);
  timer.schedule(75);
  vi.advanceTimersByTime(50);
  expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(25);
  expect(callback).toHaveBeenCalledTimes(1);
  timer.schedule();
  vi.advanceTimersByTime(99);
  expect(callback).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(callback).toHaveBeenCalledTimes(2);
  timer.schedule();
  timer.cancel();
  vi.advanceTimersByTime(100);
  expect(callback).toHaveBeenCalledTimes(2);
  timer.schedule();
  dispose();
  vi.advanceTimersByTime(100);
  expect(callback).toHaveBeenCalledTimes(2);
});

it("preserves a reactive deadline across equal refreshes and cancels when paused or disposed", () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const [source, setSource] = createSignal<{ delay?: number }>({ delay: 100 });
  const dispose = createRoot((stop) => {
    createTimeout(callback, () => source().delay);
    return stop;
  });
  onTestFinished(dispose);
  flush();
  vi.advanceTimersByTime(50);
  setSource({ delay: 100 });
  flush();
  vi.advanceTimersByTime(50);
  expect(callback).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(100);
  expect(callback).toHaveBeenCalledTimes(1);

  setSource({ delay: 200 });
  flush();
  vi.advanceTimersByTime(100);
  setSource({ delay: 50 });
  flush();
  vi.advanceTimersByTime(49);
  expect(callback).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(callback).toHaveBeenCalledTimes(2);

  setSource({ delay: 100 });
  flush();
  setSource({});
  flush();
  vi.advanceTimersByTime(100);
  expect(callback).toHaveBeenCalledTimes(2);
  setSource({ delay: 100 });
  flush();
  dispose();
  vi.advanceTimersByTime(100);
  expect(callback).toHaveBeenCalledTimes(2);
});
