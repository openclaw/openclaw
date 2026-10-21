import { createEffect, onSettled } from "solid-js";
import { cancelLayout, scheduleLayout } from "../layout-frame.ts";

/** Coalesce size and defined invalidations; returned writes run after layout reads. */
export function createLayoutMeasurement<T>(
  changed: () => T,
  measure: (invalidation: T | undefined) => (() => void) | void,
  options: {
    targets: () => readonly Element[];
    mutations?: () => Node;
    /** Keyboard and disclosure commits need geometry before the next animation frame. */
    changeTiming?: "sync";
  },
) {
  const key = {};
  let ready = false;
  let invalidation: T | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let observed = new Set<Element>();
  const read = () => {
    const targets = options.targets();
    if (!targets[0]?.isConnected) {
      return;
    }
    const next = new Set(targets);
    for (const target of observed) {
      if (!next.has(target)) {
        resizeObserver?.unobserve(target);
      }
    }
    for (const target of next) {
      if (!observed.has(target)) {
        resizeObserver?.observe(target);
      }
    }
    observed = next;
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
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(schedule);
    }
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
      cancelLayout(key);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  });
  return schedule;
}
