import { describe, expect, it, vi } from "vitest";
import { computeBackoff, sleepWithAbort } from "./backoff.js";

describe("computeBackoff", () => {
  const policy = { initialMs: 100, maxMs: 5000, factor: 2, jitter: 0 };

  it("returns initialMs for attempt 1 with no jitter", () => {
    expect(computeBackoff(policy, 1)).toBe(100);
  });

  it("doubles for attempt 2", () => {
    expect(computeBackoff(policy, 2)).toBe(200);
  });

  it("caps at maxMs", () => {
    expect(computeBackoff(policy, 100)).toBe(5000);
  });

  it("treats attempt 0 same as attempt 1", () => {
    expect(computeBackoff(policy, 0)).toBe(100);
  });

  it("adds jitter when configured", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const jitterPolicy = { initialMs: 100, maxMs: 10000, factor: 2, jitter: 0.2 };
    const result = computeBackoff(jitterPolicy, 1);
    // base=100, jitter=100*0.2*0.5=10 → 110
    expect(result).toBe(110);
    vi.restoreAllMocks();
  });

  it("rounds to integer", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const jitterPolicy = { initialMs: 100, maxMs: 10000, factor: 2, jitter: 0.1 };
    const result = computeBackoff(jitterPolicy, 1);
    expect(Number.isInteger(result)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("sleepWithAbort", () => {
  it("resolves immediately for ms <= 0", async () => {
    await sleepWithAbort(0);
    await sleepWithAbort(-1);
  });

  it("throws on aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(10000, controller.signal)).rejects.toThrow("aborted");
  });
});
