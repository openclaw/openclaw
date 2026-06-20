import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { t } from "../i18n/index.ts";
import type { RouteMatch, Router, RouterState } from "../router/types.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { measureControlUiRender } from "../ui/control-ui-performance.ts";

type RenderableModule<TContext, TData> = {
  render: (context: TContext, data: TData | undefined) => unknown;
};

export type RouterOutletOptions<
  TRouteId extends string,
  TLoadContext = unknown,
  TData = unknown,
> = {
  fallbackRouteId?: TRouteId;
  retryContext?: TLoadContext;
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

type RouterRenderContext = {
  state: AppViewState;
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

function renderPending() {
  return html`
    <section class="card lazy-view-state lazy-view-state--loading" role="status">
      <div class="card-title">${t("lazyView.loadingTitle")}</div>
      <div class="card-sub">${t("common.loading")}</div>
    </section>
  `;
}

function renderError<TRouteId extends string, TLoadContext, TModule, TData>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  retryContext: TLoadContext | undefined,
  error: unknown,
  routeId: TRouteId,
  render?: () => unknown,
) {
  const routeError = error instanceof Error ? error.message : String(error);
  return html`
    ${render?.() ?? nothing}
    <div class="callout danger" role="alert">
      <strong>${t("lazyView.errorTitle")}</strong>
      <div>${routeError}</div>
      <button
        class="btn btn--sm"
        @click=${() =>
          retryContext === undefined
            ? undefined
            : void router.revalidate(retryContext, routeId).catch(() => undefined)}
      >
        ${t("lazyView.retry")}
      </button>
    </div>
  `;
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
  options: RouterOutletOptions<TRouteId, TLoadContext, TData> = {},
): unknown {
  const state = router.getState();
  const activeMatch = state.matches[0];
  const pendingMatch = state.pendingMatches[0];
  const boundaryMatch =
    pendingMatch?.status === "notFound" || pendingMatch?.status === "redirected"
      ? pendingMatch
      : activeMatch;
  if (boundaryMatch?.status === "notFound") {
    return null;
  }
  if (boundaryMatch?.status === "redirected") {
    return null;
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
      return renderError(router, options.retryContext, errorMatch.error, errorMatch.routeId);
    }
    return renderPending();
  }

  const module =
    activeMatch?.routeId === routeId
      ? activeMatch.module
      : pendingMatch?.routeId === routeId
        ? pendingMatch.module
        : undefined;
  const renderedMatch = activeMatch?.routeId === routeId ? activeMatch : pendingMatch;
  if (renderedMatch?.status === "pending") {
    return renderPending();
  }
  if (!module) {
    return renderPending();
  }
  if (!isRenderableModule<TContext, TData>(module)) {
    return errorMatch?.error
      ? renderError(router, options.retryContext, errorMatch.error, routeId)
      : null;
  }
  const renderPage = () => module.render(context, renderedMatch?.data);
  const renderedPage = () => {
    const renderContext = context as RouterRenderContext;
    return measureControlUiRender(
      renderContext.state,
      routeId as AppViewState["routeId"],
      { routeId },
      renderPage,
    );
  };
  return errorMatch?.error
    ? renderError(router, options.retryContext, errorMatch.error, routeId, renderedPage)
    : renderedPage();
}

class RouterOutletDirective extends AsyncDirective {
  private router?: RouterOutletRuntime;
  private context: unknown;
  private options: RouterOutletOptions<string, unknown, unknown> = {};
  private unsubscribe?: () => boolean;

  override render(
    router: unknown,
    context: unknown,
    options: RouterOutletOptions<string, unknown, unknown> = {},
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
  options: RouterOutletOptions<TRouteId, TLoadContext, TData> = {},
): unknown {
  return routerOutletDirective(
    router,
    context,
    options as unknown as RouterOutletOptions<string, unknown, unknown>,
  );
}
