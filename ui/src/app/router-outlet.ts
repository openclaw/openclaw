import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import type { RouteMatch, Router, RouterState } from "../router/types.ts";

type RenderableModule<TContext, TData> = {
  render: (context: TContext, data: TData | undefined) => unknown;
};

export type RouterOutletOptions<TRouteId extends string, TData = unknown> = {
  fallbackRouteId?: TRouteId;
  pending?: (state: RouterState<TRouteId, unknown, TData>) => unknown;
  error?: (
    error: unknown,
    state: RouterState<TRouteId, unknown, TData>,
    render?: () => unknown,
  ) => unknown;
  notFound?: (
    match: RouteMatch<TRouteId, unknown, TData>,
    state: RouterState<TRouteId, unknown, TData>,
  ) => unknown;
  redirect?: (
    match: RouteMatch<TRouteId, unknown, TData>,
    state: RouterState<TRouteId, unknown, TData>,
  ) => unknown;
  onRender?: (
    routeId: TRouteId,
    state: RouterState<TRouteId, unknown, TData>,
    render: () => unknown,
  ) => unknown;
};

type RouterOutletSelection = {
  status: RouterState<string, unknown, unknown>["status"];
  active: RouteMatch<string, unknown, unknown> | undefined;
  pending: RouteMatch<string, unknown, unknown> | undefined;
};

function selectRouterOutletState(
  state: RouterState<string, unknown, unknown>,
): RouterOutletSelection {
  return {
    status: state.status,
    active: state.matches[0],
    pending: state.pendingMatches[0],
  };
}

function equalRouterOutletState(
  previous: RouterOutletSelection,
  next: RouterOutletSelection,
): boolean {
  return (
    previous.status === next.status &&
    previous.active === next.active &&
    previous.pending === next.pending
  );
}

type RouterOutletRuntime = Router<string, unknown, unknown, unknown>;

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

export function renderRouterOutlet<
  TRouteId extends string,
  TLoadContext,
  TModule,
  TContext,
  TData = unknown,
>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  context: TContext,
  options: RouterOutletOptions<TRouteId, TData> = {},
): unknown {
  const state = router.getState();
  const activeMatch = state.matches[0];
  const pendingMatch = state.pendingMatches[0];
  const boundaryMatch =
    pendingMatch?.status === "notFound" || pendingMatch?.status === "redirected"
      ? pendingMatch
      : activeMatch;
  if (boundaryMatch?.status === "notFound") {
    return options.notFound?.(boundaryMatch, state) ?? null;
  }
  if (boundaryMatch?.status === "redirected") {
    return options.redirect?.(boundaryMatch, state) ?? null;
  }
  const errorMatch =
    pendingMatch?.status === "error" || activeMatch?.status === "error"
      ? pendingMatch?.status === "error"
        ? pendingMatch
        : activeMatch
      : undefined;
  const routeId =
    activeMatch?.routeId ??
    (state.status === "idle" || state.status === "loading" ? options.fallbackRouteId : null);
  if (!routeId) {
    if (errorMatch?.error) {
      return options.error?.(errorMatch.error, state) ?? null;
    }
    return options.pending?.(state) ?? null;
  }

  const route = router.getRoute(routeId);
  const module =
    activeMatch?.routeId === routeId
      ? activeMatch.module
      : pendingMatch?.routeId === routeId
        ? pendingMatch.module
        : undefined;
  const renderedMatch = activeMatch?.routeId === routeId ? activeMatch : pendingMatch;
  if (route?.component && !module) {
    return options.pending?.(state) ?? null;
  }
  if (!isRenderableModule<TContext, TData>(module)) {
    return errorMatch?.error ? (options.error?.(errorMatch.error, state) ?? null) : null;
  }
  const renderPage = () => module.render(context, renderedMatch?.data);
  const renderedPage = options.onRender
    ? () => options.onRender?.(routeId, state, renderPage)
    : renderPage;
  return errorMatch?.error
    ? (options.error?.(errorMatch.error, state, renderedPage) ?? renderedPage())
    : renderedPage();
}

class RouterOutletDirective extends AsyncDirective {
  private router?: RouterOutletRuntime;
  private context: unknown;
  private options: RouterOutletOptions<string, unknown> = {};
  private unsubscribe?: () => boolean;

  override render(
    router: unknown,
    context: unknown,
    options: RouterOutletOptions<string, unknown> = {},
  ) {
    const runtime = router as RouterOutletRuntime;
    this.updateSubscription(runtime);
    this.context = context;
    this.options = options;
    return renderRouterOutlet(runtime, context, options);
  }

  override disconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  override reconnected() {
    if (this.router) {
      this.updateSubscription(this.router);
    }
  }

  private updateSubscription(router: Router<string, unknown, unknown, unknown>) {
    if (this.router === router && this.unsubscribe) {
      return;
    }
    this.unsubscribe?.();
    this.router = router;
    this.unsubscribe = router.subscribeSelector(
      selectRouterOutletState,
      () => {
        if (this.isConnected) {
          this.setValue(renderRouterOutlet(router, this.context, this.options));
        }
      },
      equalRouterOutletState,
    );
  }
}

const routerOutletDirective = directive(RouterOutletDirective);

export function routerOutlet<
  TRouteId extends string,
  TLoadContext,
  TModule,
  TContext,
  TData = unknown,
>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  context: TContext,
  options: RouterOutletOptions<TRouteId, TData> = {},
): unknown {
  return routerOutletDirective(
    router,
    context,
    options as unknown as RouterOutletOptions<string, unknown>,
  );
}
