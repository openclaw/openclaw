import { i18n } from "../i18n/lib/translate.ts";
import { cancelLayout, scheduleLayout } from "../lib/layout-frame.ts";
import { observeFontLoading } from "../lib/reactive/font-loading.ts";
import { listen } from "../lib/reactive/listener.ts";

export type ScrollState = { scrollable: boolean; atStart: boolean; atEnd: boolean };

export function scrollStateForGeometry(
  size: number,
  viewport: number,
  position: number,
): ScrollState {
  const scrollable = size > viewport + 1;
  return {
    scrollable,
    atStart: !scrollable || position <= 1,
    atEnd: !scrollable || position + viewport >= size - 1,
  };
}

type Observation = {
  horizontal: boolean;
  trackScroll: boolean;
  publish: (state: ScrollState) => void;
};
const observations = new Map<
  HTMLElement,
  { entries: Set<Observation>; stopScroll: () => void; stopFonts?: () => void }
>();
let resizeObserver: ResizeObserver | undefined;
let stopLocale: (() => void) | undefined;

function schedule(element: HTMLElement): void {
  scheduleLayout(element, () => {
    const entries = observations.get(element)?.entries;
    if (!entries || !element.isConnected) {
      return undefined;
    }
    const states = new Map<boolean, ScrollState>();
    const updates = [...entries].map((entry) => {
      let state = states.get(entry.horizontal);
      if (!state) {
        const size = entry.horizontal ? element.scrollWidth : element.scrollHeight;
        const viewport = entry.horizontal ? element.clientWidth : element.clientHeight;
        // Horizontal consumers describe physical left/right edges, including in RTL.
        const position = entry.horizontal
          ? getComputedStyle(element).direction === "rtl"
            ? size - viewport + element.scrollLeft
            : element.scrollLeft
          : element.scrollTop;
        state = scrollStateForGeometry(size, viewport, position);
        states.set(entry.horizontal, state);
      }
      return { entry, state };
    });
    return () => {
      for (const { entry, state } of updates) {
        if (observations.get(element)?.entries.has(entry)) {
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
    [...(observations.get(element)?.entries ?? [])].some((entry) => entry.trackScroll)
  ) {
    schedule(element);
  }
}

/** Share one observer and frame read across an element's consumers. */
export function observeScrollState(
  element: HTMLElement,
  publish: (state: ScrollState) => void,
  horizontal = false,
  trackScroll = true,
): { schedule: () => void; disconnect: () => void } {
  let group = observations.get(element);
  if (!group) {
    group = {
      entries: new Set(),
      stopScroll: listen(element, "scroll", onScroll, { passive: true }),
    };
    observations.set(element, group);
    // Locale loading can change direction without resizing or scrolling the element.
    stopLocale ??= i18n.subscribe(() => {
      for (const [target, current] of observations) {
        if ([...current.entries].some((entry) => entry.horizontal)) {
          schedule(target);
        }
      }
    });
    // Refs can still belong to the inert template document before adoption.
    const fonts = document.fonts;
    if (fonts) {
      // Font metrics can change the overflow without resizing the viewport.
      // The initial frame covers loaded fonts without forcing style through fonts.ready.
      group.stopFonts = observeFontLoading(fonts, () => schedule(element));
    }
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
  }
  const { entries, stopScroll } = group;
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
        stopScroll();
        group.stopFonts?.();
        cancelLayout(element);
        if (observations.size === 0) {
          resizeObserver?.disconnect();
          resizeObserver = undefined;
          stopLocale?.();
          stopLocale = undefined;
        }
      }
    },
  };
}
