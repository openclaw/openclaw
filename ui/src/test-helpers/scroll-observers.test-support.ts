import { onTestFinished, vi } from "vitest";

class FixtureObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

export function stubResizeObserver(): void {
  vi.stubGlobal("ResizeObserver", FixtureObserver);
  onTestFinished(() => vi.unstubAllGlobals());
}

/** Non-layout rendering fixtures only; geometry tests own their delivery clock. */
export function stubScrollObservers(): void {
  stubResizeObserver();
  vi.stubGlobal("IntersectionObserver", FixtureObserver);
}
