import { onTestFinished, vi } from "vitest";

/** Non-layout rendering fixtures only; geometry tests own their delivery clock. */
export function stubScrollObservers(): void {
  for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  onTestFinished(() => vi.unstubAllGlobals());
}
