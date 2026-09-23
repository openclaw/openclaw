import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "./absolute-deadline.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

it("uses the selected elapsed clock when wall time changes", async () => {
  let elapsed = 50;
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(
    () => operation.promise,
    60,
    () => elapsed,
  );

  vi.setSystemTime(10_000);
  elapsed = 59.5;
  operation.resolve("in time");

  await expect(result).resolves.toBe("in time");
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a result at the selected deadline before its timer runs", async () => {
  let elapsed = 50;
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(
    () => operation.promise,
    60,
    () => elapsed,
  );

  elapsed = 60;
  operation.resolve("late");

  await expect(result).resolves.toBe(ABSOLUTE_DEADLINE_EXPIRED);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains wall-clock settlement when no clock is selected", async () => {
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(() => operation.promise, 100);

  vi.setSystemTime(1_000);
  operation.resolve("late");

  await expect(result).resolves.toBe(ABSOLUTE_DEADLINE_EXPIRED);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases the deadline timer when the operation rejects", async () => {
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(() => operation.promise, 100);
  operation.reject(new Error("operation failed"));

  await expect(result).rejects.toThrow("operation failed");
  expect(vi.getTimerCount()).toBe(0);
});
