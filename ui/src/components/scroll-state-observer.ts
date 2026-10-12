import { cancelLayout, scheduleLayout } from "../lib/layout-frame.ts";

export type ScrollState = { scrollable: boolean; atStart: boolean; atEnd: boolean };
type Observation = {
  horizontal: boolean;
  trackScroll: boolean;
  publish: (state: ScrollState) => void;
};
const observations = new Map<HTMLElement, Set<Observation>>();
let resizeObserver: ResizeObserver | undefined;

function schedule(element: HTMLElement): void {
  scheduleLayout(element, () => {
    const entries = observations.get(element);
    if (!entries || !element.isConnected) {
      return undefined;
    }
    const states = new Map<boolean, ScrollState>();
    const updates = [...entries].map((entry) => {
      let state = states.get(entry.horizontal);
      if (!state) {
        const size = entry.horizontal ? element.scrollWidth : element.scrollHeight;
        const viewport = entry.horizontal ? element.clientWidth : element.clientHeight;
        const position = entry.horizontal ? element.scrollLeft : element.scrollTop;
        const scrollable = size > viewport + 1;
        state = {
          scrollable,
          atStart: !scrollable || position <= 1,
          atEnd: !scrollable || position + viewport >= size - 1,
        };
        states.set(entry.horizontal, state);
      }
      return { entry, state };
    });
    return () => {
      for (const { entry, state } of updates) {
        if (observations.get(element)?.has(entry)) {
          entry.publish(state);
        }
      }
    };
  });
}

function onScroll(event: Event): void {
  const element = event.currentTarget;
  if (
    element instanceof HTMLElement &&
    [...(observations.get(element) ?? [])].some((entry) => entry.trackScroll)
  ) {
    schedule(element);
  }
}

/** One observer and one frame batch serve directives and sidebar scroll state. */
export function observeScrollState(
  element: HTMLElement,
  publish: (state: ScrollState) => void,
  horizontal = false,
  trackScroll = true,
): { schedule: () => void; disconnect: () => void } {
  let entries = observations.get(element);
  if (!entries) {
    observations.set(element, (entries = new Set()));
    if (!resizeObserver && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((resized) => {
        for (const { target } of resized) {
          if (target instanceof HTMLElement) {
            schedule(target);
          }
        }
      });
    }
    resizeObserver?.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
  }
  const entry = { horizontal, trackScroll, publish };
  entries.add(entry);
  schedule(element);
  return {
    schedule: () => schedule(element),
    disconnect: () => {
      entries.delete(entry);
      if (entries.size === 0) {
        observations.delete(element);
        resizeObserver?.unobserve(element);
        element.removeEventListener("scroll", onScroll);
        cancelLayout(element);
        if (observations.size === 0) {
          resizeObserver?.disconnect();
          resizeObserver = undefined;
        }
      }
    },
  };
}
