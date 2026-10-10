import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import { renderAgentStartupState, renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderLoadingState } from "../components/loading-state.ts";
import { McpAppUnmountGate } from "../components/mcp-app-unmount.ts";
import { i18n } from "../i18n/index.ts";
import { isAgentDatabaseInspectionPendingError } from "../lib/gateway-availability.ts";
import { projectI18n, t } from "../lib/reactive/i18n.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { LitRouteHost } from "./lit-route-host.tsx";
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
  readTranslations?: () => void;
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
    return null;
  }

  const routeId = renderedMatch.routeId;
  if (!renderedMatch.module || renderedMatch.error !== undefined) {
    options.readTranslations?.();
  }
  if (!renderedMatch.module) {
    return renderedMatch.error
      ? renderError(router, options.retryContext, renderedMatch.error, routeId)
      : showPending
        ? renderLoadingState()
        : null;
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

export type RouterOutletProps = {
  inert?: boolean;
  "aria-disabled"?: "true" | "false";
  router?: ApplicationRouter;
  retryContext?: ApplicationContext;
  onNotFound?: () => boolean | void;
  notFoundRecoveryReady?: boolean;
  retryEnabled?: boolean;
  retentionScope?: object;
  ref?: (element: ControlUiReadinessOutlet) => void;
};

type Presentation = { key: string; render: (presented: boolean) => unknown };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-router-outlet": HTMLAttributes<HTMLElement>;
    }
  }
}

/** Solid owns route lifetimes; unported modules own only their Lit island children. */
export function RouterOutlet(props: RouterOutletProps): SolidJSX.Element {
  const translations = projectI18n(i18n);
  const readTranslations = () => {
    translations.revision();
  };
  let host!: HTMLElement;
  let disposed = false;
  let generation = 0;
  let committedGeneration = -1;
  let committedSettled = false;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const resolve of waiters) {
      resolve();
    }
    waiters.clear();
  };
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const invalidate = () => {
    generation += 1;
    if (!disposed) {
      setRevision((value) => value + 1);
    }
    notify();
  };
  const outlet = new RouterOutletController<
    ApplicationRouteMatch["routeId"],
    ApplicationContext,
    NonNullable<ApplicationRouteMatch["module"]>
  >(invalidate);
  const retainedGate = new McpAppUnmountGate<Presentation | null>({ requestUpdate: invalidate });
  const transientGate = new McpAppUnmountGate<Presentation | null>({ requestUpdate: invalidate });
  let retainedMatch: ApplicationRouteMatch | undefined;
  let retainedOwnerKey: string | undefined;
  let retainedPresented = false;
  let scopeRouter: ApplicationRouter | undefined;
  let scopeOwner: object | undefined;
  let scopeInitialized = false;
  let scopeGeneration = 0;
  let scopeRefreshing = false;
  let retiredSessionMatches = new Set<string>();

  const synchronizeRetentionScope = (router: ApplicationRouter) => {
    const routerChanged = scopeRouter !== router;
    const changed = scopeInitialized && (routerChanged || scopeOwner !== props.retentionScope);
    scopeInitialized = true;
    scopeRouter = router;
    scopeOwner = props.retentionScope;
    if (!changed) {
      return;
    }
    const currentGeneration = ++scopeGeneration;
    retainedMatch = undefined;
    retainedOwnerKey = undefined;
    retainedPresented = false;
    scopeRefreshing = false;
    retiredSessionMatches = new Set(
      routerChanged
        ? []
        : [...router.getState().matches, ...router.getState().pendingMatches]
            .filter((match) => isSessionRouteId(match.routeId))
            .map((match) => match.id),
    );
    if (routerChanged) {
      return;
    }
    const context = props.retryContext;
    const scope = props.retentionScope;
    const state = router.getState();
    const target = state.pendingMatches[0] ?? state.matches[0];
    if (context === undefined || !target || !isSessionRouteId(target.routeId)) {
      return;
    }
    scopeRefreshing = true;
    // Retire the old scope's loader without changing its destination or history.
    void router
      .navigate(target.routeId, context, { history: "none", revalidate: true }, target.location)
      .finally(() =>
        untrack(() => {
          if (
            !disposed &&
            props.router === router &&
            props.retentionScope === scope &&
            scopeGeneration === currentGeneration
          ) {
            scopeRefreshing = false;
            invalidate();
          }
        }),
      )
      .catch(() => undefined);
  };

  const presentation = createMemo(() => {
    revision();
    outlet.setInputs({
      router: props.router,
      onNotFound: props.onNotFound,
      notFoundRecoveryReady: props.notFoundRecoveryReady,
      retryContext: props.retryContext,
      retryEnabled: props.retryEnabled,
    });
    const router = props.router;
    if (!router) {
      return { retained: null, transient: null, presented: false, waiting: false, settled: false };
    }
    synchronizeRetentionScope(router);
    const snapshot = outlet.snapshot;
    const renderedMatch = selectRenderedRouteMatch(snapshot.active, snapshot.pending);
    const ready = renderedMatch?.status === "success" && renderedMatch.error === undefined;
    const retiredSession =
      renderedMatch !== undefined && retiredSessionMatches.has(renderedMatch.id);
    const scopeReady = !scopeRefreshing && !retiredSession;
    const routeKey = renderedMatch ? `${renderedMatch.routeId}:${renderedMatch.status}` : "empty";
    const module = renderedMatch?.module;
    const declaredOwnerKey = renderedMatch
      ? module?.renderOwnerKey?.(renderedMatch, snapshot.settled)
      : undefined;
    const explicitOwnerKey = renderedMatch?.error === undefined ? declaredOwnerKey : undefined;
    const waiting = renderedMatch?.status === "pending" || renderedMatch?.isFetching === "loader";
    const settled =
      snapshot.status !== "idle" &&
      snapshot.status !== "loading" &&
      !snapshot.pending &&
      !snapshot.startupPending &&
      scopeReady &&
      !waiting;
    const retainPending = waiting && retainedPresented && retainedOwnerKey === explicitOwnerKey;
    const presentRetained =
      scopeReady &&
      module?.retainOnNavigate === true &&
      explicitOwnerKey !== undefined &&
      (ready || retainPending);
    if (presentRetained && ready) {
      retainedMatch = renderedMatch;
      retainedOwnerKey = explicitOwnerKey;
    } else if (snapshot.status === "idle" || (scopeReady && module?.retainOnNavigate && !waiting)) {
      retainedMatch = undefined;
      retainedOwnerKey = undefined;
    }
    retainedPresented = presentRetained;
    const retained = retainedMatch;
    const retainedKey = `${scopeGeneration}:${retainedOwnerKey ?? "empty"}`;
    const transientKey = presentRetained ? "empty" : (explicitOwnerKey ?? routeKey);
    const retryContext = props.retryContext;
    const renderTransient = () => {
      if (snapshot.startupPending) {
        readTranslations();
        return renderAgentStartupState();
      }
      if (isSessionRouteId(renderedMatch?.routeId) && !scopeReady) {
        readTranslations();
        return !retiredSession && renderedMatch?.error !== undefined
          ? renderError(router, retryContext, renderedMatch.error, renderedMatch.routeId)
          : renderLoadingState();
      }
      if (module?.retainOnNavigate && waiting) {
        if (renderedMatch?.routeId === "chat" && snapshot.settled?.routeId === "new-session") {
          return renderRouterOutlet(router, snapshot.showPending, snapshot.settled, {
            retryContext,
            readTranslations,
          });
        }
        readTranslations();
        return renderLoadingState();
      }
      return renderRouterOutlet(router, snapshot.showPending, renderedMatch, {
        retryContext,
        readTranslations,
      });
    };
    const retainedValue = retainedGate.render(
      retainedKey,
      () =>
        retained
          ? {
              key: retainedKey,
              render: (presented) =>
                renderRouterOutlet(router, snapshot.showPending, retained, {
                  retryContext,
                  presented,
                }),
            }
          : null,
      () => (host ? host.querySelectorAll(":scope > openclaw-route-presentation") : []),
    );
    const transientValue = transientGate.render(
      transientKey,
      () => (presentRetained ? null : { key: transientKey, render: renderTransient }),
      () => (host ? host.querySelectorAll(":scope > openclaw-route-fragment") : []),
      {
        retainRenderedValue:
          !module?.retainOnNavigate &&
          explicitOwnerKey !== undefined &&
          renderedMatch?.status === "pending" &&
          renderedMatch.data === undefined,
      },
    );
    return {
      retained: retainedValue,
      transient: transientValue,
      presented: presentRetained && !retainedGate.retiring && retainedValue?.key === retainedKey,
      waiting: presentRetained && retainedGate.retiring,
      settled: settled && !retainedGate.retiring && !transientGate.retiring,
    };
  });

  createEffect(presentation, (value) => {
    committedSettled = value.settled;
    committedGeneration = generation;
    notify();
  });

  const isSettled = () =>
    !disposed && host.isConnected && committedGeneration === generation && committedSettled;
  const settlePresentation = async (): Promise<boolean> => {
    while (true) {
      if (disposed || !host.isConnected) {
        return false;
      }
      const current = generation;
      // The island commits with Solid; descendants own their independent work.
      await Promise.resolve();
      if (disposed || !host.isConnected) {
        return false;
      }
      if (current !== generation || committedGeneration !== generation) {
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
        continue;
      }
      if (!retainedGate.retiring && !transientGate.retiring) {
        return isSettled();
      }
      await new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    }
  };

  outlet.connect();
  onCleanup(() => {
    disposed = true;
    outlet.disconnect();
    notify();
  });

  return (
    <openclaw-router-outlet
      inert={props.inert}
      aria-disabled={props["aria-disabled"]}
      ref={(element) => {
        host = element;
        const readinessHost = Object.defineProperties(element, {
          presentationSettled: { configurable: true, get: isSettled },
          settlePresentation: { configurable: true, value: settlePresentation },
        }) as ControlUiReadinessOutlet; // SAFETY: These descriptors define the outlet contract.
        untrack(() => props.ref?.(readinessHost));
      }}
    >
      <Show when={presentation().retained?.key} keyed>
        {(_ownerKey) => (
          <LitRouteHost
            presentation
            presented={presentation().presented}
            renderValue={() => presentation().retained?.render(presentation().presented)}
          />
        )}
      </Show>
      <Show when={Boolean(presentation().transient)}>
        <LitRouteHost renderValue={() => presentation().transient?.render(true)} />
      </Show>
      <Show when={presentation().waiting}>
        <LitRouteHost
          renderValue={() => {
            readTranslations();
            return renderLoadingState();
          }}
        />
      </Show>
    </openclaw-router-outlet>
  );
}
