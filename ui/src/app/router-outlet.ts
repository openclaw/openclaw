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

type RouterViewSelection = {
  status: RouterState<string, unknown, unknown>["status"];
  activeRouteId: string | undefined;
  activeModule: unknown;
  pendingRouteId: string | undefined;
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

function selectRouterViewState(state: RouterState<string, unknown, unknown>): RouterViewSelection {
  const active = state.matches[0];
  return {
    status: state.status,
    activeRouteId: active?.routeId,
    activeModule: active?.module,
    pendingRouteId: state.pendingMatches[0]?.routeId,
  };
}

function equalRouterViewState(previous: RouterViewSelection, next: RouterViewSelection): boolean {
  return (
    previous.status === next.status &&
    previous.activeRouteId === next.activeRouteId &&
    previous.activeModule === next.activeModule &&
    previous.pendingRouteId === next.pendingRouteId
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
  const renderedMatch = state.pendingMatches[0] ?? state.matches[0];
  if (renderedMatch?.status === "notFound") {
    return null;
  }
  if (renderedMatch?.status === "redirected") {
    return null;
  }
  const routeId =
    renderedMatch?.routeId ??
    (state.status === "idle" || state.status === "loading" ? options.fallbackRouteId : null);
  if (!routeId) {
    if (renderedMatch?.error) {
      return renderError(router, options.retryContext, renderedMatch.error, renderedMatch.routeId);
    }
    return renderPending();
  }

  if (!renderedMatch?.module) {
    return renderPending();
  }
  if (!isRenderableModule<TContext, TData>(renderedMatch.module)) {
    return renderedMatch.error
      ? renderError(router, options.retryContext, renderedMatch.error, routeId)
      : null;
  }
  const renderPage = () => renderedMatch.module.render(context, renderedMatch.data);
  const renderedPage = () => {
    const renderContext = context as RouterRenderContext;
    return measureControlUiRender(
      renderContext.state,
      routeId as AppViewState["routeId"],
      { routeId },
      renderPage,
    );
  };
  return renderedMatch.error
    ? renderError(router, options.retryContext, renderedMatch.error, routeId, renderedPage)
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

class RouterViewDirective extends AsyncDirective {
  private router?: RouterOutletRuntime;
  private context: unknown;
  private renderView?: (selection: RouterViewSelection, context: unknown) => unknown;
  private unsubscribe?: () => boolean;

  override render(
    router: unknown,
    context: unknown,
    renderView: (selection: RouterViewSelection, context: unknown) => unknown,
  ) {
    const runtime = router as RouterOutletRuntime;
    this.updateSubscription(runtime);
    this.context = context;
    this.renderView = renderView;
    return renderView(selectRouterViewState(runtime.getState()), context);
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

  private updateSubscription(router: RouterOutletRuntime) {
    if (this.router === router && this.unsubscribe) {
      return;
    }
    this.unsubscribe?.();
    this.router = router;
    this.unsubscribe = router.subscribeSelector(
      selectRouterViewState,
      (selection) => {
        if (this.isConnected && this.renderView) {
          this.setValue(this.renderView(selection, this.context));
        }
      },
      equalRouterViewState,
    );
  }
}

const routerViewDirective = directive(RouterViewDirective);

export function routerView<TContext>(
  router: Router<string, unknown, unknown, unknown>,
  context: TContext,
  render: (selection: RouterViewSelection, context: TContext) => unknown,
): unknown {
  return routerViewDirective(router, context, render);
}

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
