// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollController } from "./poll-controller.ts";

class TestHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    const index = this.controllers.indexOf(controller);
    if (index !== -1) {
      this.controllers.splice(index, 1);
    }
  }

  connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
  }

  disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function browserVisibility(initial: DocumentVisibilityState) {
  let visibility = initial;
  const events = new EventTarget();
  Object.defineProperty(events, "visibilityState", { get: () => visibility });
  vi.stubGlobal("document", events);
  return (next: DocumentVisibilityState) => {
    visibility = next;
    events.dispatchEvent(new Event("visibilitychange"));
  };
}

describe("PollController", () => {
  it("starts explicitly, ticks idempotently, and stops", () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const tick = vi.fn();
    const polling = new PollController(host, 1_000, tick, false);

    expect(polling.start()).toBe(true);
    expect(polling.start()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);

    polling.stop();
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("auto-starts on connect and always stops on disconnect", () => {
    vi.useFakeTimers();
    browserVisibility("hidden");
    const host = new TestHost();
    const tick = vi.fn();
    const polling = new PollController(host, 500, tick);
    expect(host.controllers).toContain(polling);

    host.connect();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledOnce();

    host.disconnect();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledOnce();
  });

  it.each(["visible", "hidden"] as const)(
    "pauses opted-in polling while hidden and catches up once (initially %s)",
    (initial) => {
      vi.useFakeTimers();
      const visibility = browserVisibility(initial);
      const host = new TestHost();
      const tick = vi.fn();
      const polling = new PollController(host, 1_000, tick, true, "visible");

      host.connect();
      expect(polling.start()).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(initial === "visible" ? 1 : 0);
      tick.mockClear();
      visibility("hidden");
      vi.advanceTimersByTime(5_000);
      expect(tick).not.toHaveBeenCalled();

      visibility("visible");
      visibility("visible");
      expect(tick).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(2);

      host.disconnect();
      visibility("hidden");
      visibility("visible");
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(2);
    },
  );

  it("does not revive explicitly stopped polling when a hidden tab returns", () => {
    vi.useFakeTimers();
    const visibility = browserVisibility("hidden");
    const host = new TestHost();
    const tick = vi.fn();
    const polling = new PollController(host, 1_000, tick, false, "visible");

    host.connect();
    expect(polling.start()).toBe(true);
    expect(polling.start()).toBe(false);
    polling.stop();
    visibility("visible");
    vi.advanceTimersByTime(1_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
