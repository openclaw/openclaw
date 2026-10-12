import { cancelLayout, scheduleLayout } from "../lib/layout-frame.ts";

export type ScrollState = { scrollable: boolean; atStart: boolean; atEnd: boolean };
type Observation = {
  horizontal: boolean;
  trackScroll: boolean;
  publish: (state: ScrollState) => void;
};
type Scroller = {
  entries: Set<Observation>;
  content: MutationObserver;
  targets: Set<Element>;
  visible: boolean;
};
const observations = new Map<HTMLElement, Scroller>();
const resizeOwners = new Map<Element, Set<HTMLElement>>();
let resizeObserver: ResizeObserver | undefined;
let visibilityObserver: IntersectionObserver | undefined;

function schedule(element: HTMLElement): void {
  const scroller = observations.get(element);
  if (!scroller?.visible) {
    return;
  }
  scheduleLayout(element, () => {
    if (!observations.has(element) || !element.isConnected || !element.checkVisibility()) {
      return undefined;
    }
    const states = new Map<boolean, ScrollState>();
    const updates = [...scroller.entries].map((entry) => {
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

function onContentLoad(event: Event): void {
  if (event.currentTarget instanceof HTMLElement) {
    schedule(event.currentTarget);
  }
}

function onFontsLoaded(): void {
  for (const element of observations.keys()) {
    schedule(element);
  }
}

function updateResizeTargets(
  element: HTMLElement,
  scroller: Scroller,
  targets = new Set<Element>([element, ...element.children]),
): void {
  // A fixed scrollport does not resize when its block content grows. Inline
  // intrinsic changes instead arrive through resource/font load notifications.
  for (const target of scroller.targets) {
    if (!targets.has(target)) {
      const owners = resizeOwners.get(target)!;
      owners.delete(element);
      if (owners.size === 0) {
        resizeOwners.delete(target);
        resizeObserver?.unobserve(target);
      }
    }
  }
  for (const target of targets) {
    let owners = resizeOwners.get(target);
    if (!owners) {
      resizeOwners.set(target, (owners = new Set()));
      resizeObserver!.observe(target);
    }
    owners.add(element);
  }
  scroller.targets = targets;
}

/** Shared observations and one frame batch serve directives and sidebar scroll state. */
export function observeScrollState(
  element: HTMLElement,
  publish: (state: ScrollState) => void,
  horizontal = false,
  trackScroll = true,
): { schedule: () => void; disconnect: () => void } {
  let scroller = observations.get(element);
  if (!scroller) {
    resizeObserver ??= new ResizeObserver((resized) => {
      for (const { target } of resized) {
        for (const owner of resizeOwners.get(target) ?? []) {
          schedule(owner);
        }
      }
    });
    visibilityObserver ??= new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        if (!(target instanceof HTMLElement)) {
          continue;
        }
        const observed = observations.get(target);
        if (observed) {
          observed.visible = isIntersecting;
          if (isIntersecting) {
            schedule(target);
          } else {
            cancelLayout(target);
          }
        }
      }
    });
    const content = new MutationObserver((records) => {
      const observed = observations.get(element);
      if (!observed) {
        return;
      }
      if (records.some((record) => record.type === "childList")) {
        updateResizeTargets(element, observed);
      }
      // Publishing scroll affordances must not invalidate the next measurement.
      if (
        records.some(
          (record) =>
            !["data-scrollable", "data-at-start", "data-at-end"].includes(
              record.attributeName ?? "",
            ),
        )
      ) {
        schedule(element);
      }
    });
    scroller = { entries: new Set(), content, targets: new Set(), visible: false };
    if (observations.size === 0) {
      document.fonts?.addEventListener("loadingdone", onFontsLoaded);
    }
    observations.set(element, scroller);
    content.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    updateResizeTargets(element, scroller);
    visibilityObserver.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("load", onContentLoad, true);
  }
  const entry = { horizontal, trackScroll, publish };
  scroller.entries.add(entry);
  schedule(element);
  return {
    schedule: () => schedule(element),
    disconnect: () => {
      scroller.entries.delete(entry);
      if (scroller.entries.size === 0) {
        observations.delete(element);
        scroller.content.disconnect();
        updateResizeTargets(element, scroller, new Set());
        visibilityObserver?.unobserve(element);
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener("load", onContentLoad, true);
        cancelLayout(element);
        if (observations.size === 0) {
          resizeObserver?.disconnect();
          resizeObserver = undefined;
          visibilityObserver?.disconnect();
          visibilityObserver = undefined;
          document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
        }
      }
    },
  };
}
