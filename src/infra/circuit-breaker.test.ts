import { describe, expect, it } from "vitest";
import { createCircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";

describe("circuit breaker", () => {
  const succeed = () => Promise.resolve("ok");
  const fail = () => Promise.reject(new Error("boom"));

  it("starts in closed state and passes through successful calls", async () => {
    const cb = createCircuitBreaker();
    expect(cb.state()).toBe("closed");
    expect(await cb.call(succeed)).toBe("ok");
    expect(cb.failures()).toBe(0);
  });

  it("counts consecutive failures and opens at threshold", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow("boom");
    }

    expect(cb.state()).toBe("open");
    expect(cb.failures()).toBe(3);
  });

  it("rejects immediately when open and reports remaining time", async () => {
    let nowMs = 1000;
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      resetMs: 5000,
      now: () => nowMs,
    });

    await expect(cb.call(fail)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");

    try {
      await cb.call(succeed);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as CircuitBreakerOpenError).remainingMs).toBe(5000);
    }
  });

  it("transitions to half-open after resetMs elapses", async () => {
    let nowMs = 0;
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      resetMs: 100,
      now: () => nowMs,
    });

    await expect(cb.call(fail)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");

    nowMs += 100;
    await expect(cb.call(succeed)).resolves.toBe("ok");
    expect(cb.state()).toBe("closed");
  });

  it("re-opens on failure during half-open probe", async () => {
    let nowMs = 0;
    const cb = createCircuitBreaker({
      failureThreshold: 2,
      resetMs: 100,
      now: () => nowMs,
    });

    await expect(cb.call(fail)).rejects.toThrow();
    await expect(cb.call(fail)).rejects.toThrow();
    expect(cb.state()).toBe("open");

    nowMs += 100;
    // Half-open probe fails → back to open
    await expect(cb.call(fail)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");
  });

  it("resets consecutive failures on success", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    await expect(cb.call(fail)).rejects.toThrow();
    await expect(cb.call(fail)).rejects.toThrow();
    expect(cb.failures()).toBe(2);

    await cb.call(succeed);
    expect(cb.failures()).toBe(0);
    expect(cb.state()).toBe("closed");
  });

  it("respects shouldTrip predicate", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      shouldTrip: (err) => err instanceof TypeError,
    });

    // Regular error should not trip
    await expect(cb.call(() => Promise.reject(new Error("nope")))).rejects.toThrow();
    expect(cb.state()).toBe("closed");

    // TypeError should trip
    await expect(cb.call(() => Promise.reject(new TypeError("bad")))).rejects.toThrow();
    expect(cb.state()).toBe("open");
  });

  it("manual reset restores closed state", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });

    await expect(cb.call(fail)).rejects.toThrow();
    expect(cb.state()).toBe("open");

    cb.reset();
    expect(cb.state()).toBe("closed");
    expect(cb.failures()).toBe(0);
    expect(await cb.call(succeed)).toBe("ok");
  });

  it("enforces failureThreshold minimum of 1", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 0 });

    await expect(cb.call(fail)).rejects.toThrow();
    expect(cb.state()).toBe("open");
  });
});
