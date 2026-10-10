import { vi } from "vitest";

export function message(id: string, role: string, content: unknown, seq: number, runId?: string) {
  return {
    role,
    content,
    timestamp: seq * 1_000,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  };
}

export function stubRailVisibility() {
  let publishVisibility: (element: Element) => void = () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        publishVisibility = (element) => {
          const rect = element.getBoundingClientRect();
          callback(
            [
              {
                target: element,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: rect,
                intersectionRatio: 1,
                isIntersecting: true,
                time: 0,
              },
            ],
            this,
          );
        };
      }
      takeRecords = () => [];
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  return (element: Element) => publishVisibility(element);
}
