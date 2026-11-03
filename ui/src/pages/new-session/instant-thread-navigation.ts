import type { RouteLocation } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { listen } from "../../lib/reactive/listener.ts";

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
  // Each newer location must abort the owned navigation before asynchronous work commits.
  const stop = router.subscribe((state) => {
    if (state.location !== ownedLocation) {
      controller.abort();
    }
  });
  const stopAbort = listen(signal, "abort", stop, { once: true });
  return {
    ready: navigation.catch(() => undefined),
    signal,
    isActive: () => !signal.aborted && router.getState().location === ownedLocation,
    dispose() {
      stop();
      stopAbort();
    },
  };
}
