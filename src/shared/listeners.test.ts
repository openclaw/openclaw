import { describe, expect, it, vi } from "vitest";
import { notifyListeners, registerListener } from "./listeners.js";

describe("notifyListeners", () => {
  it("calls every registered listener with the event", () => {
    const received: number[] = [];
    const a = (n: number) => received.push(n);
    const b = (n: number) => received.push(n * 2);

    notifyListeners([a, b], 5);
    expect(received).toEqual([5, 10]);
  });

  it("isolates listener errors to the onError callback", () => {
    const errors: unknown[] = [];
    const failing = () => {
      throw new Error("boom");
    };
    const ok = vi.fn();

    notifyListeners([failing, ok], null, (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty listener set", () => {
    expect(() => notifyListeners([], "event")).not.toThrow();
  });
});

describe("registerListener", () => {
  it("adds a listener and returns an unsubscribe function", () => {
    const listeners = new Set<(e: string) => void>();
    const fn = vi.fn();

    const unsubscribe = registerListener(listeners, fn);
    expect(listeners.has(fn)).toBe(true);

    unsubscribe();
    expect(listeners.has(fn)).toBe(false);
  });

  it("unsubscribe is idempotent", () => {
    const listeners = new Set<(e: string) => void>();
    const fn = vi.fn();

    const unsubscribe = registerListener(listeners, fn);
    unsubscribe();
    unsubscribe(); // should not throw
    expect(listeners.has(fn)).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
