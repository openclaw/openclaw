import { vi } from "vitest";

export function stubManualIntersectionObserver(
  onObserve: (target: Element, notify: (isIntersecting: boolean) => void) => void,
) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        onObserve(target, (isIntersecting) => {
          if (this.targets.has(target)) {
            // SAFETY: Media viewport callbacks read only target and isIntersecting.
            this.callback(
              [{ target, isIntersecting } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
}
