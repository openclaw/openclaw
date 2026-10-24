/** Save-Data applies to speculative code and data, including hover/focus intent. */
export function canPreload(): boolean {
  // SAFETY: Network Information is optional and is not in TypeScript's DOM library.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return navigator.onLine && !connection?.saveData && document.visibilityState === "visible";
}

export function scheduleRoutePreload<TRouteId extends string>(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  routeId: TRouteId,
  event: Event,
  preload: ((routeId: TRouteId) => Promise<void> | void) | undefined,
  disabled = false,
  immediate = false,
) {
  const target = event.currentTarget;
  if (disabled || !preload || !target) {
    return;
  }
  const start = async () => {
    timers.delete(target);
    if (!canPreload()) {
      return;
    }
    try {
      await preload(routeId);
    } catch {
      // Preloading is opportunistic; navigation still handles real route errors.
    }
  };
  if (immediate) {
    cancelRoutePreload(timers, event);
    void start();
    return;
  }
  if (!timers.has(target)) {
    timers.set(target, globalThis.setTimeout(() => void start(), 50));
  }
}

export function cancelRoutePreload(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  event: Event,
) {
  const target = event.currentTarget;
  if (!target) {
    return;
  }
  globalThis.clearTimeout(timers.get(target));
  timers.delete(target);
}
