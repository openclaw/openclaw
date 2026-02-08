/**
 * Consistency tests to verify that the unified withTimeout behaves
 * identically to the original inline implementations.
 */
import { describe, expect, it } from "vitest";

import { withTimeout } from "./with-timeout.js";

// Original implementation from slack/probe.ts and line/probe.ts
function originalWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

describe("withTimeout consistency with original implementation", () => {
  it("both resolve when promise completes before timeout", async () => {
    const promise = Promise.resolve("ok");

    const originalResult = await originalWithTimeout(promise, 1000);
    const newResult = await withTimeout(Promise.resolve("ok"), 1000, "timeout");

    expect(originalResult).toBe("ok");
    expect(newResult).toBe("ok");
  });

  it("both reject with same error message on timeout", async () => {
    const createSlowPromise = () =>
      new Promise((resolve) => setTimeout(() => resolve("late"), 100));

    let originalError: Error | null = null;
    let newError: Error | null = null;

    try {
      await originalWithTimeout(createSlowPromise(), 10);
    } catch (err) {
      originalError = err as Error;
    }

    try {
      await withTimeout(createSlowPromise(), 10, "timeout");
    } catch (err) {
      newError = err as Error;
    }

    expect(originalError).not.toBeNull();
    expect(newError).not.toBeNull();
    expect(originalError!.message).toBe("timeout");
    expect(newError!.message).toBe("timeout");
  });

  it("both return promise directly when timeoutMs is 0", async () => {
    const promise = Promise.resolve("ok");

    const originalResult = await originalWithTimeout(promise, 0);
    const newResult = await withTimeout(Promise.resolve("ok"), 0, "timeout");

    expect(originalResult).toBe("ok");
    expect(newResult).toBe("ok");
  });

  it("both return promise directly when timeoutMs is negative", async () => {
    const promise = Promise.resolve("ok");

    const originalResult = await originalWithTimeout(promise, -1);
    const newResult = await withTimeout(Promise.resolve("ok"), -1, "timeout");

    expect(originalResult).toBe("ok");
    expect(newResult).toBe("ok");
  });

  it("both propagate rejection from original promise", async () => {
    let originalError: Error | null = null;
    let newError: Error | null = null;

    try {
      await originalWithTimeout(Promise.reject(new Error("original error")), 1000);
    } catch (err) {
      originalError = err as Error;
    }

    try {
      await withTimeout(Promise.reject(new Error("original error")), 1000, "timeout");
    } catch (err) {
      newError = err as Error;
    }

    expect(originalError).not.toBeNull();
    expect(newError).not.toBeNull();
    expect(originalError!.message).toBe("original error");
    expect(newError!.message).toBe("original error");
  });
});
