import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTerminalKeyboardReserve } from "./terminal-keyboard-reserve.ts";

/**
 * Stubs window.visualViewport with controllable height, offsetTop, and scale.
 * vitest's vi.stubGlobal replaces the property on the window object; we use
 * Object.defineProperty so the stub is configurable and restorable.
 */
function stubVisualViewport(opts: { height: number; offsetTop?: number; scale?: number }): {
  trigger: (event: "resize" | "scroll") => void;
} {
  const listeners: Record<string, Array<() => void>> = {};
  const vv = {
    height: opts.height,
    offsetTop: opts.offsetTop ?? 0,
    scale: opts.scale ?? 1,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  vi.stubGlobal("visualViewport", vv);
  return {
    trigger(event: "resize" | "scroll") {
      for (const fn of listeners[event] ?? []) {
        fn();
      }
    },
  };
}

/**
 * Stubs window.innerHeight (read-only in browsers, configurable in jsdom).
 */
function stubInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("observeTerminalKeyboardReserve", () => {
  let container: HTMLDivElement;
  let cleanupReserve: (() => void) | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    cleanupReserve = undefined;
  });

  afterEach(() => {
    cleanupReserve?.();
    cleanupReserve = undefined;
    container.remove();
    vi.unstubAllGlobals();
    // Reset configurable properties.
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 768,
      configurable: true,
      writable: true,
    });
  });

  function setupCoarseDevice(): void {
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
  }

  function setupNonTouchDevice(): void {
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
  }

  it("at scale 1 with keyboard open (innerHeight 676, vv.height 363, offsetTop 0): applies 313 px padding", async () => {
    setupCoarseDevice();
    stubInnerHeight(676);
    const vv = stubVisualViewport({ height: 363, offsetTop: 0, scale: 1 });

    cleanupReserve = observeTerminalKeyboardReserve(container);

    // scheduleUpdate uses requestAnimationFrame; flush it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("313px");

    // Verify it also responds to a viewport resize event.
    // Simulate keyboard closing.
    stubInnerHeight(676);
    // Update vv height to match innerHeight (keyboard gone).
    vi.stubGlobal("visualViewport", {
      ...window.visualViewport,
      height: 676,
      offsetTop: 0,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vv.trigger("resize");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("");
  });

  it("at scale 1 with keyboard closed (vv.height = innerHeight): applies no padding", async () => {
    setupCoarseDevice();
    stubInnerHeight(800);
    stubVisualViewport({ height: 800, offsetTop: 0, scale: 1 });

    cleanupReserve = observeTerminalKeyboardReserve(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("");
  });

  it("at scale 2 (pinch-zoom) with open-looking gap: applies no padding (zoom guard)", async () => {
    setupCoarseDevice();
    // At scale 2, innerHeight 915 vs vv.height 457.5 looks like a 457.5 px gap
    // but it is actually the zoom factor, not a keyboard.
    stubInnerHeight(915);
    stubVisualViewport({ height: 457.5, offsetTop: 0, scale: 2 });

    cleanupReserve = observeTerminalKeyboardReserve(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("");
  });

  it("on non-touch device: no padding applied even with a large gap", async () => {
    setupNonTouchDevice();
    stubInnerHeight(676);
    stubVisualViewport({ height: 363, offsetTop: 0, scale: 1 });

    cleanupReserve = observeTerminalKeyboardReserve(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("");
  });

  it("cleanup removes listeners so subsequent viewport resize has no effect", async () => {
    setupCoarseDevice();
    stubInnerHeight(676);
    const vv = stubVisualViewport({ height: 363, offsetTop: 0, scale: 1 });

    const cleanup = observeTerminalKeyboardReserve(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Confirm padding was applied.
    expect(container.style.paddingBottom).toBe("313px");

    // Cleanup resets padding and removes listeners.
    cleanup();
    expect(container.style.paddingBottom).toBe("");

    // Trigger a resize; padding must not come back.
    vv.trigger("resize");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.style.paddingBottom).toBe("");
  });
});
