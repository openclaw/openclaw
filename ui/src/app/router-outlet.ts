import { html, LitElement, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { property } from "lit/decorators.js";
import { directive } from "lit/directive.js";
import { t } from "../i18n/index.ts";
import type { RouteMatch, Router, RouterState } from "../router/types.ts";

const PENDING_UI_DELAY_MS = 1_000;

type RenderableModule<TData> = {
  render: (data: TData | undefined) => unknown;
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
  showPending: boolean;
};

function selectRouterOutletState<TRouteId extends string, TModule, TData>(
  state: RouterState<TRouteId, TModule, TData>,
): RouterOutletSelection<TRouteId, TModule, TData> {
  return {
    status: state.status,
    active: state.matches[0],
    pending: state.pendingMatches[0],
    showPending: false,
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

function isRenderableModule<TData>(module: unknown): module is RenderableModule<TData> {
  return (
    typeof module === "object" &&
    module !== null &&
    "render" in module &&
    typeof module.render === "function"
  );
}

function measureRoutedRender<T>(routeId: string, render: () => T): T {
  const startedAt = globalThis.performance?.now() ?? 0;
  const result = render();
  const durationMs = Math.round((globalThis.performance?.now() ?? startedAt) - startedAt);
  if (durationMs >= 16) {
    console.debug("[openclaw] routed render", { routeId, durationMs });
  }
  return result;
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

export function renderRouterOutlet<TRouteId extends string, TLoadContext, TModule, TData = unknown>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  selection: RouterOutletSelection<TRouteId, TModule, TData>,
  options: RouterOutletOptions<TRouteId, TLoadContext, TData> = {},
): unknown {
  const renderedMatch = selection.pending ?? selection.active;
  if (renderedMatch?.status === "notFound") {
    return nothing;
  }
  if (renderedMatch?.status === "redirected") {
    return nothing;
  }
  if (!renderedMatch) {
    return nothing;
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
      : selection.showPending
        ? renderPending()
        : nothing;
  }
  const routeModule = renderedMatch.module;
  if (!isRenderableModule<TData>(routeModule)) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : null;
  }
  const renderedPage = () =>
    measureRoutedRender(routeId, () => routeModule.render(renderedMatch.data));
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
  private router?: Router<string, unknown, unknown, unknown>;
  private retryContext: unknown;
  private unsubscribe?: () => void;
  private boundaryOptions?: RouterOutletBoundaryOptions;
  private notFoundScheduled = false;
  private pendingMatchId?: string;
  private pendingTimer?: ReturnType<typeof globalThis.setTimeout>;
  private pendingSelection?: RouterOutletSelection;
  private showPending = false;

  override render(
    router: unknown,
    retryContext: unknown,
    boundaryOptions: RouterOutletBoundaryOptions,
  ) {
    const nextRouter = router as Router<string, unknown, unknown, unknown>;
    this.updateSubscription(nextRouter);
    this.router = nextRouter;
    this.retryContext = retryContext;
    this.boundaryOptions = boundaryOptions;
    return this.renderSelection(selectRouterOutletState(nextRouter.getState()));
  }

  override disconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearPendingTimer();
    this.pendingSelection = undefined;
    this.boundaryOptions = undefined;
    this.retryContext = undefined;
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
    this.unsubscribe = router.subscribeSelector(
      selectRouterOutletState,
      (selection) => {
        if (this.isConnected) {
          this.setValue(this.renderSelection(selection));
        }
      },
      equalRouterOutletState,
    );
  }

  private renderSelection(selection: RouterOutletSelection) {
    this.pendingSelection = selection;
    const pending = selection.pending;
    const coldPending =
      pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
    if (!coldPending) {
      this.clearPendingTimer();
      this.pendingMatchId = undefined;
      this.showPending = false;
    } else if (this.pendingMatchId !== pending.id) {
      this.clearPendingTimer();
      this.pendingMatchId = pending.id;
      this.showPending = false;
      this.pendingTimer = globalThis.setTimeout(() => {
        this.pendingTimer = undefined;
        const pendingSelection = this.pendingSelection;
        if (!pendingSelection || pendingSelection.pending?.id !== this.pendingMatchId) {
          return;
        }
        this.showPending = true;
        this.setValue(this.renderSelection(pendingSelection));
      }, PENDING_UI_DELAY_MS);
    }
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
    const router = this.router;
    if (!router) {
      return nothing;
    }
    return renderRouterOutlet(
      router,
      { ...selection, showPending: this.showPending },
      {
        retryContext: this.retryContext,
      },
    );
  }

  private clearPendingTimer() {
    if (this.pendingTimer !== undefined) {
      globalThis.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }
}

const routerOutletDirective = directive(RouterOutletDirective);

export function routerOutlet<TRouteId extends string, TModule, TData, TContext>(
  router: Router<TRouteId, TContext, TModule, TData>,
  boundaryOptions: RouterOutletBoundaryOptions,
  options: RouterOutletOptions<TRouteId, TContext, TData> = {},
): unknown {
  return routerOutletDirective(router, options.retryContext, boundaryOptions);
}

export class OpenClawRouterOutlet<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> extends LitElement {
  @property({ attribute: false }) router?: Router<TRouteId, TLoadContext, TModule, TData>;
  @property({ attribute: false }) retryContext?: TLoadContext;
  @property({ attribute: false }) onNotFound?: () => void;

  override createRenderRoot() {
    return this;
  }

  override render() {
    if (!this.router) {
      return nothing;
    }
    return routerOutlet(
      this.router,
      { onNotFound: this.onNotFound },
      {
        retryContext: this.retryContext,
      },
    );
  }
}

if (!customElements.get("openclaw-router-outlet")) {
  customElements.define("openclaw-router-outlet", OpenClawRouterOutlet);
}
