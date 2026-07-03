import { describe, expect, it, vi } from "vitest";
import { notifyListeners, registerListener } from "./listeners.js";

describe("notifyListeners", () => {
  it("calls every registered listener with the event", () => {
    const a = vi.fn();
    const b = vi.fn();
    notifyListeners([a, b], { key: "value" });
    expect(a).toHaveBeenCalledWith({ key: "value" });
    expect(b).toHaveBeenCalledWith({ key: "value" });
  });

  it("handles an empty iterable without error", () => {
    expect(() => notifyListeners([], "event")).not.toThrow();
  });

  it("continues to other listeners when one throws", () => {
    const a = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    notifyListeners([a, b], "event");
    expect(b).toHaveBeenCalledWith("event");
  });

  it("calls onError when a listener throws", () => {
    const error = new Error("listener failed");
    const onError = vi.fn();
    notifyListeners(
      [
        () => {
          throw error;
        },
      ],
      "event",
      onError,
    );
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("does not call onError when no listener throws", () => {
    const onError = vi.fn();
    notifyListeners([vi.fn(), vi.fn()], "event", onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it("works with Set as an iterable", () => {
    const a = vi.fn();
    const b = vi.fn();
    notifyListeners(new Set([a, b]), "event");
    expect(a).toHaveBeenCalledWith("event");
    expect(b).toHaveBeenCalledWith("event");
  });
});

describe("registerListener", () => {
  it("adds the listener to the set", () => {
    const listeners = new Set<(_: string) => void>();
    const fn = vi.fn();
    registerListener(listeners, fn);
    expect(listeners.has(fn)).toBe(true);
  });

  it("returns an unsubscribe function that removes the listener", () => {
    const listeners = new Set<(_: string) => void>();
    const fn = vi.fn();
    const unsubscribe = registerListener(listeners, fn);
    expect(listeners.has(fn)).toBe(true);
    unsubscribe();
    expect(listeners.has(fn)).toBe(false);
  });

  it("calling unsubscribe twice is idempotent", () => {
    const listeners = new Set<(_: string) => void>();
    const fn = vi.fn();
    const unsubscribe = registerListener(listeners, fn);
    unsubscribe();
    unsubscribe();
    expect(listeners.has(fn)).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
