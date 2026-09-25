import type { RouteLocation } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";

/** A history-free route remains owned until a newer navigation or app shutdown. */
export function beginInstantThreadNavigation(
  context: ApplicationContext,
  routeId: "chat" | "new-session",
  options: RouteLocation,
) {
  const { router, lifecycleAbortSignal } = context;
  const controller = new AbortController();
  const navigation = router.navigate(routeId, context, { history: "none" }, options);
  // Router locations are unique per navigation, including navigation to the same URL.
  const ownedLocation = router.getState().location;
  const signal = lifecycleAbortSignal
    ? AbortSignal.any([controller.signal, lifecycleAbortSignal])
    : controller.signal;
  const stop = router.subscribe((state) => {
    if (state.location !== ownedLocation) {
      controller.abort();
    }
  });
  const dispose = () => {
    stop();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    ready: navigation.catch(() => undefined),
    signal,
    isActive: () => !signal.aborted && router.getState().location === ownedLocation,
    dispose,
  };
}
