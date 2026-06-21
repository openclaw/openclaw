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
  retryContext?: TLoadContext;
};

export type RouterOutletBoundaryOptions = {
  onNotFound?: () => void;
};

export type RouterOutletSelection<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = {
  status: RouterState<TRouteId, TModule, TData>["status"];
  active: RouteMatch<TRouteId, TModule, TData> | undefined;
  pending: RouteMatch<TRouteId, TModule, TData> | undefined;
};

function selectRouterOutletState<TRouteId extends string, TModule, TData>(
  state: RouterState<TRouteId, TModule, TData>,
): RouterOutletSelection<TRouteId, TModule, TData> {
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
  selection: RouterOutletSelection<TRouteId, TModule, TData>,
  options: RouterOutletOptions<TRouteId, TLoadContext, TData> = {},
): unknown {
  const renderedMatch = selection.pending ?? selection.active;
  if (renderedMatch?.status === "notFound") {
    return renderPending();
  }
  if (renderedMatch?.status === "redirected") {
    return renderPending();
  }
  if (!renderedMatch) {
    return renderPending();
  }

  const routeId = renderedMatch.routeId;
  if (!renderedMatch?.module) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : renderPending();
  }
  const routeModule = renderedMatch.module;
  if (!isRenderableModule<TContext, TData>(routeModule)) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : null;
  }
  const renderPage = () => routeModule.render(context, renderedMatch.data);
  const renderedPage = () => {
    const renderContext = context as RouterRenderContext;
    return measureControlUiRender(renderContext.state, routeId, { routeId }, renderPage);
  };
  return renderedMatch.error
    ? renderError<TRouteId, TLoadContext, TModule, TData>(
        router,
        options.retryContext,
        renderedMatch.error,
        routeId,
        renderedPage,
      )
    : renderedPage();
}

class RouterOutletDirective extends AsyncDirective {
  private router?: RouterOutletRuntime;
  private context: unknown;
  private renderApp?: (selection: RouterOutletSelection, context: unknown) => unknown;
  private unsubscribe?: () => boolean;
  private boundaryOptions?: RouterOutletBoundaryOptions;
  private notFoundScheduled = false;

  override render(
    router: unknown,
    context: unknown,
    boundaryOptions: RouterOutletBoundaryOptions,
    renderApp: (selection: RouterOutletSelection, context: unknown) => unknown,
  ) {
    const runtime = router as RouterOutletRuntime;
    this.updateSubscription(runtime);
    this.context = context;
    this.boundaryOptions = boundaryOptions;
    this.renderApp = renderApp;
    return this.renderSelection(selectRouterOutletState(runtime.getState()));
  }

  override disconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.boundaryOptions = undefined;
    this.notFoundScheduled = false;
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
      (selection) => {
        if (this.isConnected && this.renderApp) {
          this.setValue(this.renderSelection(selection));
        }
      },
      equalRouterOutletState,
    );
  }

  private renderSelection(selection: RouterOutletSelection) {
    if (selection.status === "notFound") {
      if (!this.notFoundScheduled) {
        this.notFoundScheduled = true;
        queueMicrotask(() => {
          this.notFoundScheduled = false;
          this.boundaryOptions?.onNotFound?.();
        });
      }
    } else {
      this.notFoundScheduled = false;
    }
    return this.renderApp?.(selection, this.context);
  }
}

const routerOutletDirective = directive(RouterOutletDirective);

export function routerOutlet<TRouteId extends string, TLoadContext, TModule, TData, TContext>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  context: TContext,
  boundaryOptions: RouterOutletBoundaryOptions,
  render: (
    selection: RouterOutletSelection<TRouteId, TModule, TData>,
    context: TContext,
  ) => unknown,
): unknown {
  return routerOutletDirective(router, context, boundaryOptions, (selection, value) =>
    render(selection as RouterOutletSelection<TRouteId, TModule, TData>, value as TContext),
  );
}
