import type { RouteState, Router } from "../router/types.ts";

type RenderableModule<TContext, TData> = {
  render: (context: TContext, data: TData | undefined) => unknown;
};

export type RouterOutletOptions<TRouteId extends string> = {
  fallbackRouteId?: TRouteId;
  pending?: (state: RouteState<TRouteId>) => unknown;
  error?: (error: unknown, state: RouteState<TRouteId>, render?: () => unknown) => unknown;
  onRender?: (routeId: TRouteId, state: RouteState<TRouteId>, render: () => unknown) => unknown;
};

function isRenderableModule<TContext, TData>(
  module: unknown,
): module is RenderableModule<TContext, TData> {
  return (
    typeof module === "object" &&
    module !== null &&
    "render" in module &&
    typeof module.render === "function"
  );
}

export function renderRouterOutlet<TRouteId extends string, TLoadContext, TModule, TContext>(
  router: Router<TRouteId, TLoadContext, TModule, unknown>,
  context: TContext,
  options: RouterOutletOptions<TRouteId> = {},
): unknown {
  const state = router.getState();
  const routeId =
    state.resolvedRouteId ??
    (state.status === "idle" || state.status === "loading" ? options.fallbackRouteId : null);
  if (!routeId) {
    if (state.status === "error") {
      return options.error?.(state.error, state) ?? null;
    }
    return options.pending?.(state) ?? null;
  }

  const route = router.getRoute(routeId);
  const module = router.getLoadedModule(routeId);
  if (route?.component && !module) {
    return options.pending?.(state) ?? null;
  }
  if (!isRenderableModule<TContext, unknown>(module)) {
    return state.status === "error" ? (options.error?.(state.error, state) ?? null) : null;
  }
  const renderPage = () => module.render(context, state.resolvedData);
  const renderedPage = options.onRender
    ? () => options.onRender?.(routeId, state, renderPage)
    : renderPage;
  return state.status === "error"
    ? (options.error?.(state.error, state, renderedPage) ?? renderedPage())
    : renderedPage();
}
