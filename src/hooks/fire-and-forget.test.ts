import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { fireAndForgetBoundedHook, fireAndForgetHook } from "./fire-and-forget.js";

async function observe(task: Promise<unknown>, label = "hook failed") {
  const logger = vi.fn();
  fireAndForgetHook(task, label, logger);
  await Promise.resolve();
  return logger;
}

describe("fireAndForgetHook", () => {
  it("keeps truncated error logs free of lone surrogates", async () => {
    const logger = await observe(Promise.reject(new Error(`${"a".repeat(499)}😀tail`)), "hook");

    const message = logger.mock.calls[0]?.[0];
    assert(typeof message === "string", "expected string log message");
    expect(Buffer.from(message).toString()).toBe(message);
  });

  it("logs rejection errors as sanitized single-line messages", async () => {
    const text = "boom\0\u001f\nforged\tsecret sk-test1234567890\u007f\u2028\u2029tail\u0085\u009f";
    const logger = await observe(Promise.reject(new Error(text)));
    expect(logger).toHaveBeenNthCalledWith(
      1,
      "hook failed: boom forged secret *** tail\u0085\u009f",
    );
  });

  it("does not log for resolved tasks", async () => {
    const logger = await observe(Promise.resolve("ok"));
    expect(logger).not.toHaveBeenCalled();
  });
});

describe("fireAndForgetBoundedHook", () => {
  const logger = vi.fn();
  let pending: ReturnType<typeof createDeferred<void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    logger.mockClear();
    pending = createDeferred();
  });
  afterEach(async () => {
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each(["resolve", "reject"] as const)(
    "holds queue capacity until timed-out hooks %s",
    async (settlement) => {
      const starts: string[] = [];
      const options = { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 };
      const enqueue = (task: () => Promise<unknown>) =>
        fireAndForgetBoundedHook(task, "hook failed", logger, options);
      enqueue(function (this: unknown) {
        expect(this).toBeUndefined();
        starts.push("first");
        return pending.promise;
      });
      for (const name of ["second", "third"]) {
        enqueue(async () => {
          starts.push(name);
        });
      }

      expect(starts).toEqual([]);
      expect(logger).toHaveBeenCalledWith("hook failed: queue full; dropping hook");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(starts).toEqual(["first"]);
      expect(logger).toHaveBeenCalledWith("hook failed: timed out after 10000ms");
      if (settlement === "reject") {
        pending.reject(new Error("late hook failure"));
      } else {
        pending.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual(["first", "second"]);
      expect(logger).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("caps oversized hook timeout timers", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fireAndForgetBoundedHook(() => pending.promise, "hook failed", logger, {
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    expect(logger).toHaveBeenCalledWith(`hook failed: timed out after ${MAX_TIMER_TIMEOUT_MS}ms`);
  });
});
