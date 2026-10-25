import { onTestFinished, vi } from "vitest";

export function installResizeObserverStub() {
  // Keep native browser observers and fixtures that exercise resize delivery.
  if (typeof ResizeObserver !== "undefined") {
    return;
  }
  // JSDOM has no layout; this fixture does not simulate resize geometry.
  stubResizeObserver();
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

export function stubResizeObserver() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
