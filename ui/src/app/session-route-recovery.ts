import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "./context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

export type SessionRouteRecoveryState = {
  listening: boolean;
  interrupted?: {
    controller: AbortController;
    scope: ReturnType<typeof gatewayPresentationScope>;
  };
};

export function replaySessionRoute(
  router: ApplicationRouter,
  context: ApplicationContext<RouteId>,
  recovery: SessionRouteRecoveryState,
): void {
  const currentTarget = () => {
    const state = router.getState();
    return state.pendingMatches[0] ?? state.matches[0];
  };
  const latest = currentTarget();
  if (
    !recovery.listening ||
    !recovery.interrupted ||
    latest?.abortController !== recovery.interrupted.controller ||
    gatewayPresentationScope(context.gateway) !== recovery.interrupted.scope ||
    context.gateway.snapshot.phase !== "connected" ||
    latest.status !== "error"
  ) {
    return;
  }
  recovery.interrupted = undefined;
  // The loader publishes its error before retiring its run. Abort it so
  // same-match revalidation cannot join the already failed promise.
  latest.abortController.abort();
  if (currentTarget()?.abortController !== latest.abortController) {
    return;
  }
  void router
    .navigate(latest.routeId, context, { history: "none", revalidate: true }, latest.location)
    .catch(() => undefined);
}
