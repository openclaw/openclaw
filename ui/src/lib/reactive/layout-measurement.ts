import { createEffect, onSettled } from "solid-js";
import { cancelLayout, scheduleLayout } from "../layout-frame.ts";

/** Coalesce size and defined invalidations; returned writes run after layout reads. */
export function createLayoutMeasurement(
  changed: () => unknown,
  measure: () => (() => void) | void,
  options: { targets: () => readonly Element[]; mutations?: () => Node },
) {
  const key = {};
  let ready = false;
  let resizeObserver: ResizeObserver | undefined;
  let observed = new Set<Element>();
  const schedule = () => {
    if (!ready) {
      return;
    }
    scheduleLayout(key, () => {
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
      return measure();
    });
  };
  createEffect(changed, (invalidation) => {
    if (invalidation !== undefined) {
      schedule();
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
    schedule();
    return () => {
      ready = false;
      cancelLayout(key);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  });
  return schedule;
}
