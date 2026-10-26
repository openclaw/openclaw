import { createEffect, onSettled } from "solid-js";
import { cancelLayout, scheduleLayout } from "../layout-frame.ts";
import { observeFontLoading } from "./font-loading.ts";
import { observeResize } from "./observers.ts";

/** Coalesce size and defined invalidations; returned writes run after layout reads. */
export function createLayoutMeasurement<T>(
  changed: () => T,
  measure: (invalidation: T | undefined) => (() => void) | void,
  options: {
    targets: () => readonly Element[];
    mutations?: () => Node;
    fonts?: boolean;
    /** Admit a known empty layout before a measurable element exists. */
    measureWithoutTarget?: boolean;
    /** Keyboard and disclosure commits need geometry before the next animation frame. */
    changeTiming?: "sync";
  },
) {
  const key = {};
  let ready = false;
  let invalidation: T | undefined;
  let resizeAvailable = false;
  const observed = new Map<Element, () => void>();
  const read = () => {
    const targets = options.targets();
    if (!targets[0]?.isConnected) {
      for (const release of observed.values()) {
        release();
      }
      observed.clear();
      return options.measureWithoutTarget ? measure(invalidation) : undefined;
    }
    const next = new Set(targets);
    if (resizeAvailable) {
      for (const target of next) {
        if (!observed.has(target)) {
          observed.set(target, observeResize([target], schedule));
        }
      }
    }
    for (const [target, release] of observed) {
      if (!next.has(target)) {
        release();
        observed.delete(target);
      }
    }
    return measure(invalidation);
  };
  const schedule = () => {
    if (ready) {
      scheduleLayout(key, read);
    }
  };
  const commitChange = () => {
    if (!ready) {
      return;
    }
    if (options.changeTiming === "sync") {
      cancelLayout(key);
      read()?.();
    } else {
      schedule();
    }
  };
  createEffect(changed, (value) => {
    invalidation = value;
    if (value !== undefined) {
      commitChange();
    }
  });
  onSettled(() => {
    ready = true;
    // Font metrics can settle without resizing the measured viewport.
    const stopFonts = options.fonts ? observeFontLoading(document.fonts, schedule) : undefined;
    resizeAvailable = typeof ResizeObserver === "function";
    const mutationObserver = options.mutations ? new MutationObserver(schedule) : undefined;
    if (mutationObserver && options.mutations) {
      mutationObserver.observe(options.mutations(), {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    commitChange();
    return () => {
      ready = false;
      stopFonts?.();
      cancelLayout(key);
      for (const release of observed.values()) {
        release();
      }
      observed.clear();
      mutationObserver?.disconnect();
    };
  });
  return schedule;
}
