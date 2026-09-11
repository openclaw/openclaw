import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import type { ApplicationContext } from "./context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

/** Resume interrupted session reads without retiring already mounted conversations. */
export function startSessionRouteRecovery(
  router: ApplicationRouter,
  context: ApplicationContext<RouteId>,
): () => void {
  let stopped = false;
  let queued = false;
  let interrupted:
    | { controller: AbortController; scope: ReturnType<typeof gatewayPresentationScope> }
    | undefined;
  const currentTarget = () => {
    const state = router.getState();
    return state.pendingMatches[0] ?? state.matches[0];
  };
  const reconcile = () => {
    const target = currentTarget();
    const scope = gatewayPresentationScope(context.gateway);
    if (
      !target ||
      !isSessionRouteId(target.routeId) ||
      (interrupted && interrupted.controller !== target.abortController)
    ) {
      interrupted = undefined;
    }
    if (
      !target ||
      !isSessionRouteId(target.routeId) ||
      (interrupted && interrupted.scope !== scope)
    ) {
      return;
    }
    if (context.gateway.snapshot.phase !== "connected") {
      if (target.status === "pending" || target.isFetching === "loader") {
        interrupted = { controller: target.abortController, scope };
      }
      return;
    }
    if (!interrupted || queued) {
      return;
    }
    if (target.status === "success" && !target.isFetching) {
      interrupted = undefined;
      return;
    }
    if (target.status !== "error") {
      return;
    }
    queued = true;
    // Gateway and router subscribers may navigate synchronously. Recover only
    // the same interrupted load after they have published their latest intent.
    queueMicrotask(() => {
      queued = false;
      if (stopped) {
        return;
      }
      const latest = currentTarget();
      if (
        !interrupted ||
        latest?.abortController !== interrupted.controller ||
        gatewayPresentationScope(context.gateway) !== interrupted.scope ||
        context.gateway.snapshot.phase !== "connected" ||
        latest.status !== "error"
      ) {
        return;
      }
      interrupted = undefined;
      // The loader publishes its error before the router retires its run.
      // Retire it explicitly so revalidation cannot join the failed promise.
      latest.abortController.abort();
      if (currentTarget()?.abortController !== latest.abortController) {
        return;
      }
      void router
        .navigate(latest.routeId, context, { history: "none", revalidate: true }, latest.location)
        .catch(() => undefined);
    });
  };
  const stopGateway = context.gateway.subscribe(reconcile);
  const stopRouter = router.subscribe(reconcile);
  return () => {
    stopped = true;
    interrupted = undefined;
    stopGateway();
    stopRouter();
  };
}
