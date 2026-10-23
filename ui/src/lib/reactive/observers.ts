import { createEffect, createMemo, createSignal, onSettled } from "solid-js";

type ObserverTargets = readonly Element[];

function mountedTargets(targets: () => ObserverTargets) {
  const [mounted, setMounted] = createSignal(false);
  onSettled(() => {
    setMounted(true);
  });
  // Effect compute runs during setup too; refs are only safe after settlement.
  return createMemo(() => (mounted() ? targets() : []));
}

/** Observe after refs attach; replacement and owner disposal disconnect the old observer. */
export function createResizeObserver(
  targets: () => ObserverTargets,
  callback: ResizeObserverCallback,
  options?: ResizeObserverOptions,
) {
  createEffect(mountedTargets(targets), (current) => {
    if (current.length === 0 || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(callback);
    for (const element of current) {
      observer.observe(element, options);
    }
    return () => observer.disconnect();
  });
}

/** Intersection policy stays with the caller; this primitive owns only observation lifetime. */
export function createIntersectionObserver(
  targets: () => ObserverTargets,
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) {
  createEffect(mountedTargets(targets), (current) => {
    if (current.length === 0 || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver(callback, options);
    for (const element of current) {
      observer.observe(element);
    }
    return () => observer.disconnect();
  });
}
