import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { createRef, ref } from "lit/directives/ref.js";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import { renderAgentStartupState, renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderLoadingState } from "../components/loading-state.ts";
import { McpAppUnmountGate } from "../components/mcp-app-unmount.ts";
import { t } from "../i18n/index.ts";
import { isAgentDatabaseInspectionPendingError } from "../lib/gateway-availability.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { RouterOutletController, selectRenderedRouteMatch } from "./router-outlet-controller.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

type ApplicationRouteMatch = ReturnType<ApplicationRouter["getState"]>["matches"][number];

type RouterOutletOptions = {
  retryContext?: ApplicationContext;
  presented?: boolean;
};

function measureRoutedRender<T>(routeId: string, render: () => T): T {
  const startedAt = globalThis.performance?.now() ?? 0;
  const result = render();
  const durationMs = Math.round((globalThis.performance?.now() ?? startedAt) - startedAt);
  if (durationMs >= 16) {
    console.debug("[openclaw] routed render", { routeId, durationMs });
  }
  return result;
}

/**
 * Shows progress while waiting for the restarting gateway. The state lives on
 * the element rather than in render state because the reload replaces the
 * document; a re-render that resets the label is harmless, since the pending
 * wait still reloads on its own once the gateway answers.
 */
function markButtonReloading(button: HTMLButtonElement | null): () => void {
  if (!button) {
    return () => {};
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t("lazyView.reloading");
  return () => {
    button.disabled = false;
    button.textContent = label;
  };
}

function renderError(
  router: ApplicationRouter,
  retryContext: ApplicationContext | undefined,
  error: unknown,
  routeId: ApplicationRouteMatch["routeId"],
  render?: () => unknown,
) {
  if (isAgentDatabaseInspectionPendingError(error)) {
    return renderAgentStartupState();
  }
  const staleChunk = isStaleChunkImportError(error);
  if (staleChunk) {
    // Asset failures can mean an interrupted connection or a replaced build.
    // Reload also resets failed browser imports and Vite stylesheet preloads.
    void scheduleStaleChunkReload();
  }
  const handleRetry = (event: Event) => {
    if (!staleChunk) {
      if (retryContext !== undefined) {
        void router.revalidate(retryContext, routeId).catch(() => undefined);
      }
      return;
    }
    // The Gateway may still be restarting or unreachable, so wait for it to answer
    // and then reload instead of declining on the first failed probe — a silent no-op here is
    // what drives people to a manual hard reload. Reloading against an
    // unreachable gateway would replace the recoverable panel error with a
    // fatal navigation error in app webviews, so the wait is still bounded.
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    const restoreButton = markButtonReloading(button);
    void retryStaleChunkReloadWhenReachable().then((reloading) => {
      if (reloading) {
        return;
      }
      // Vite marks CSS dependencies seen before loading them. Retrying the
      // module after a failed or blocked reload can mount it without its styles.
      restoreButton();
    });
  };
  // Resource errors alone cannot establish that a newer build exists.
  return renderLazyViewError({ error, onRetry: handleRetry, render, stale: staleChunk });
}

function renderRouterOutlet(
  router: ApplicationRouter,
  showPending: boolean,
  renderedMatch: ApplicationRouteMatch | undefined,
  options: RouterOutletOptions = {},
): unknown {
  if (
    !renderedMatch ||
    renderedMatch.status === "notFound" ||
    renderedMatch.status === "redirected"
  ) {
    return nothing;
  }

  const routeId = renderedMatch.routeId;
  if (!renderedMatch.module) {
    return renderedMatch.error
      ? renderError(router, options.retryContext, renderedMatch.error, routeId)
      : showPending
        ? renderLoadingState()
        : nothing;
  }
  const routeModule = renderedMatch.module;
  const renderedPage = () =>
    measureRoutedRender(routeId, () =>
      options.presented === false
        ? routeModule.render(renderedMatch.data, renderedMatch.isFetching === "loader", false)
        : routeModule.render(renderedMatch.data, renderedMatch.isFetching === "loader"),
    );
  return renderedMatch.error
    ? renderError(
        router,
        options.retryContext,
        renderedMatch.error,
        routeId,
        routeModule.retainOnNavigate ? undefined : renderedPage,
      )
    : renderedPage();
}

/** Presentation can retire immediately while its connected subtree finishes MCP teardown. */
class OpenClawRoutePresentation extends OpenClawLightDomElement {
  @property({ attribute: false }) ownerKey = "";
  @property({ attribute: false }) renderPage: (presented: boolean) => unknown = () => nothing;
  private presentedValue = false;

  @property({ attribute: false })
  get presented(): boolean {
    return this.presentedValue;
  }
  set presented(value: boolean) {
    const previous = this.presentedValue;
    this.presentedValue = value;
    this.style.display = value ? "contents" : "none";
    this.toggleAttribute("inert", !value);
    this.setAttribute("aria-hidden", value ? "false" : "true");
    this.requestUpdate("presented", previous);
  }

  override render() {
    return this.renderPage(this.presented);
  }
}

class OpenClawRouterOutlet extends OpenClawLightDomElement implements ControlUiReadinessOutlet {
  @property({ attribute: false }) router?: ApplicationRouter;
  @property({ attribute: false }) retryContext?: ApplicationContext;
  @property({ attribute: false }) onNotFound?: () => boolean | void;
  @property({ attribute: false }) notFoundRecoveryReady?: boolean;
  @property({ attribute: false }) retryEnabled = true;
  private readonly outlet = new RouterOutletController<
    ApplicationRouteMatch["routeId"],
    ApplicationContext,
    NonNullable<ApplicationRouteMatch["module"]>
  >(() => this.requestUpdate());
  @property({ attribute: false }) retentionScope?: object;
  private readonly retainedUnmountGate = new McpAppUnmountGate(this);
  private readonly transientUnmountGate = new McpAppUnmountGate(this);
  private readonly retainedPresentation = createRef<OpenClawRoutePresentation>();
  private retainedMatch?: ApplicationRouteMatch;
  private retainedOwnerKey?: string;
  private retainedPresented = false;
  private scopeRouter?: ApplicationRouter;
  private scopeOwner?: object;
  private scopeInitialized = false;
  private scopeGeneration = 0;
  private scopeRefreshing = false;
  private retiredSessionMatches = new Set<string>();
  private renderedPresentationSettled = false;
  private committedPresentationSettled = false;
  private readonly presentationWaiters = new Set<() => void>();

  get presentationSettled(): boolean {
    return this.isConnected && !this.isUpdatePending && this.committedPresentationSettled;
  }

  async settlePresentation(): Promise<boolean> {
    while (this.isConnected) {
      await this.updateComplete;
      if (!this.isConnected) {
        return false;
      }
      if (!this.retainedUnmountGate.retiring && !this.transientUnmountGate.retiring) {
        await this.retainedPresentation.value?.updateComplete;
        if (this.isUpdatePending) {
          continue;
        }
        return this.presentationSettled;
      }
      await new Promise<void>((resolve) => {
        this.presentationWaiters.add(resolve);
      });
    }
    return false;
  }

  private notifyPresentationWaiters(): void {
    for (const resolve of this.presentationWaiters) {
      resolve();
    }
    this.presentationWaiters.clear();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.synchronizeOutletInputs();
    this.outlet.connect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.outlet.disconnect();
    this.committedPresentationSettled = false;
    this.notifyPresentationWaiters();
  }

  protected override willUpdate(): void {
    this.committedPresentationSettled = false;
    this.synchronizeOutletInputs();
  }

  protected override updated(): void {
    this.committedPresentationSettled =
      this.renderedPresentationSettled &&
      !this.retainedUnmountGate.retiring &&
      !this.transientUnmountGate.retiring;
    this.notifyPresentationWaiters();
  }

  private synchronizeOutletInputs(): void {
    this.outlet.setInputs({
      router: this.router,
      onNotFound: this.onNotFound,
      notFoundRecoveryReady: this.notFoundRecoveryReady,
      retryContext: this.retryContext,
      retryEnabled: this.retryEnabled,
    });
  }

  private synchronizeRetentionScope(router: ApplicationRouter): void {
    const routerChanged = this.scopeRouter !== router;
    const changed =
      this.scopeInitialized && (routerChanged || this.scopeOwner !== this.retentionScope);
    this.scopeInitialized = true;
    this.scopeRouter = router;
    this.scopeOwner = this.retentionScope;
    if (!changed) {
      return;
    }
    const generation = ++this.scopeGeneration;
    this.retainedMatch = undefined;
    this.retainedOwnerKey = undefined;
    this.retainedPresented = false;
    this.scopeRefreshing = false;
    this.retiredSessionMatches = new Set(
      routerChanged
        ? []
        : [...router.getState().matches, ...router.getState().pendingMatches]
            .filter((match) => isSessionRouteId(match.routeId))
            .map((match) => match.id),
    );
    if (routerChanged) {
      return;
    }
    const context = this.retryContext;
    const scope = this.retentionScope;
    const state = router.getState();
    const target = state.pendingMatches[0] ?? state.matches[0];
    if (context === undefined || !target || !isSessionRouteId(target.routeId)) {
      return;
    }
    this.scopeRefreshing = true;
    // Session loader dependencies carry this same scope. Navigating the exact
    // target retires the old load without reusing its cache or changing history.
    void router
      .navigate(target.routeId, context, { history: "none", revalidate: true }, target.location)
      .finally(() => {
        if (
          this.router === router &&
          this.retentionScope === scope &&
          this.scopeGeneration === generation
        ) {
          this.scopeRefreshing = false;
          this.requestUpdate();
        }
      })
      .catch(() => undefined);
  }

  override render() {
    this.renderedPresentationSettled = false;
    const router = this.router;
    if (!router) {
      return nothing;
    }
    const snapshot = this.outlet.snapshot;
    const renderedMatch = selectRenderedRouteMatch(snapshot.active, snapshot.pending);
    this.synchronizeRetentionScope(router);
    const ready = renderedMatch?.status === "success" && renderedMatch.error === undefined;
    const retiredSession =
      renderedMatch !== undefined && this.retiredSessionMatches.has(renderedMatch.id);
    const scopeReady = !this.scopeRefreshing && !retiredSession;
    const routeKey = renderedMatch ? `${renderedMatch.routeId}:${renderedMatch.status}` : "empty";
    const module = renderedMatch?.module;
    const declaredOwnerKey = renderedMatch
      ? module?.renderOwnerKey?.(renderedMatch, snapshot.settled)
      : undefined;
    const explicitOwnerKey = renderedMatch?.error === undefined ? declaredOwnerKey : undefined;
    const waiting = renderedMatch?.status === "pending" || renderedMatch?.isFetching === "loader";
    this.renderedPresentationSettled =
      snapshot.status !== "idle" &&
      snapshot.status !== "loading" &&
      !snapshot.pending &&
      !snapshot.startupPending &&
      scopeReady &&
      !waiting;
    const retainPending =
      waiting && this.retainedPresented && this.retainedOwnerKey === explicitOwnerKey;
    const presentRetained =
      scopeReady &&
      module?.retainOnNavigate === true &&
      explicitOwnerKey !== undefined &&
      (ready || retainPending);
    if (presentRetained && ready) {
      this.retainedMatch = renderedMatch;
      this.retainedOwnerKey = explicitOwnerKey;
    } else if (snapshot.status === "idle" || (scopeReady && module?.retainOnNavigate && !waiting)) {
      // Invalid session destinations still replace their old owner; only a
      // successful session page opts into retention across unrelated routes.
      this.retainedMatch = undefined;
      this.retainedOwnerKey = undefined;
    }
    this.retainedPresented = presentRetained;
    const retained = this.retainedMatch;
    const retainedKey = `${this.scopeGeneration}:${this.retainedOwnerKey ?? "empty"}`;
    const transientKey = presentRetained ? "empty" : (explicitOwnerKey ?? routeKey);
    const renderTransient = () => {
      if (snapshot.startupPending) {
        return renderAgentStartupState();
      }
      if (isSessionRouteId(renderedMatch?.routeId) && !scopeReady) {
        return !retiredSession && renderedMatch?.error !== undefined
          ? renderError(router, this.retryContext, renderedMatch.error, renderedMatch.routeId)
          : renderLoadingState();
      }
      // Returning from another page must not revive the previously selected
      // session while the requested destination is still unresolved.
      if (module?.retainOnNavigate && waiting) {
        // Chat's module can arrive before its submitted-prompt preview loader.
        // Keep the launcher visible until that first Chat presentation is ready.
        if (renderedMatch?.routeId === "chat" && snapshot.settled?.routeId === "new-session") {
          return renderRouterOutlet(router, snapshot.showPending, snapshot.settled, {
            retryContext: this.retryContext,
          });
        }
        return renderLoadingState();
      }
      return renderRouterOutlet(router, snapshot.showPending, renderedMatch, {
        retryContext: this.retryContext,
      });
    };
    const rendered = html`
      ${this.retainedUnmountGate.render(
        retainedKey,
        () =>
          retained
            ? keyed(
                retainedKey,
                html`<openclaw-route-presentation
                  ${ref(this.retainedPresentation)}
                  .ownerKey=${retainedKey}
                  .presented=${presentRetained}
                  .renderPage=${(presented: boolean) =>
                    renderRouterOutlet(router, snapshot.showPending, retained, {
                      retryContext: this.retryContext,
                      presented,
                    })}
                ></openclaw-route-presentation>`,
              )
            : nothing,
        () => (this.retainedPresentation.value ? [this.retainedPresentation.value] : []),
      )}
      ${this.transientUnmountGate.render(
        transientKey,
        () => (presentRetained ? nothing : renderTransient()),
        () => [...this.children].filter((child) => child !== this.retainedPresentation.value),
        {
          retainRenderedValue:
            !module?.retainOnNavigate &&
            explicitOwnerKey !== undefined &&
            renderedMatch?.status === "pending" &&
            renderedMatch.data === undefined,
        },
      )}
      ${presentRetained && this.retainedUnmountGate.retiring ? renderLoadingState() : nothing}
    `;
    // The gates publish retirement during render and schedule surviving MCP
    // restarts before these presentation updates. A returning owner stays inert
    // throughout teardown, even when its key matches the still-connected subtree.
    if (this.retainedPresentation.value) {
      this.retainedPresentation.value.presented =
        presentRetained &&
        !this.retainedUnmountGate.retiring &&
        this.retainedPresentation.value.ownerKey === retainedKey;
    }
    return rendered;
  }
}

if (!customElements.get("openclaw-route-presentation")) {
  customElements.define("openclaw-route-presentation", OpenClawRoutePresentation);
}

if (!customElements.get("openclaw-router-outlet")) {
  customElements.define("openclaw-router-outlet", OpenClawRouterOutlet);
}
