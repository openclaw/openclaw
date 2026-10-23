import { Dynamic, type JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { SolidRouteProps } from "../app-route-types.tsx";
import type { ApplicationRouter } from "../app-routes.ts";
import { createMcpAppUnmountGate } from "../components/mcp-app-unmount.ts";
import { AgentStartupState, LazyViewError } from "../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../components/solid/loading-state.tsx";
import { isAgentDatabaseInspectionPendingError } from "../lib/gateway-availability.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { RouteElements, type RouteElementEvent } from "./route-elements.ts";
import {
  createRouterOutletPresentation,
  selectRenderedRouteMatch,
} from "./router-outlet-presentation.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

type ApplicationRouteMatch = ReturnType<ApplicationRouter["getState"]>["matches"][number];

type RouteErrorProps = {
  router: ApplicationRouter;
  retryContext?: ApplicationContext;
  error: unknown;
  routeId: ApplicationRouteMatch["routeId"];
  inline?: boolean;
};

function RouteError(props: RouteErrorProps) {
  const staleChunk = () => isStaleChunkImportError(props.error);
  const handleRetry = (event: Event) => {
    if (!staleChunk()) {
      if (props.retryContext !== undefined) {
        void props.router.revalidate(props.retryContext, props.routeId).catch(() => undefined);
      }
      return;
    }
    // The Gateway may still be restarting or unreachable, so wait for it to answer
    // and then reload instead of declining on the first failed probe — a silent no-op here is
    // what drives people to a manual hard reload. Reloading against an
    // unreachable gateway would replace the recoverable panel error with a
    // fatal navigation error in app webviews, so the wait is still bounded.
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    const label = button?.textContent ?? null;
    if (button) {
      button.disabled = true;
      button.textContent = t("lazyView.reloading");
    }
    void retryStaleChunkReloadWhenReachable().then((reloading) => {
      if (!reloading && button) {
        // Failed reloads leave this error view available for another attempt.
        button.disabled = false;
        button.textContent = label;
      }
    });
  };
  // Resource errors alone cannot establish that a newer build exists.
  return (
    <>
      <Show when={staleChunk()}>
        {(_stale) => {
          onSettled(() => {
            void scheduleStaleChunkReload();
          });
          return <></>;
        }}
      </Show>
      <Show
        when={!isAgentDatabaseInspectionPendingError(props.error)}
        fallback={<AgentStartupState />}
      >
        <LazyViewError
          error={props.error}
          onRetry={handleRetry}
          inline={props.inline}
          stale={staleChunk()}
        />
      </Show>
    </>
  );
}

function renderRouterOutlet(
  router: ApplicationRouter,
  renderedMatch: ApplicationRouteMatch | undefined,
  retryContext?: ApplicationContext,
  presented = true,
): RouteContent {
  if (
    !renderedMatch ||
    renderedMatch.status === "notFound" ||
    renderedMatch.status === "redirected"
  ) {
    return { state: "empty" };
  }

  const routeId = renderedMatch.routeId;
  const error = renderedMatch.error
    ? { router, retryContext, error: renderedMatch.error, routeId }
    : undefined;
  if (!renderedMatch.module) {
    return { state: error ? "empty" : "loading", error };
  }
  const routeModule = renderedMatch.module;
  if (
    error &&
    (routeModule.retainOnNavigate || isAgentDatabaseInspectionPendingError(error.error))
  ) {
    return { state: "empty", error };
  }
  return {
    render: routeModule.renderSolid,
    props: {
      data: renderedMatch.data,
      loaderPending: renderedMatch.isFetching === "loader",
      presented,
    },
    error: error ? { ...error, inline: true } : undefined,
  };
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

type RouteContent =
  | {
      render: (props: SolidRouteProps) => SolidJSX.Element;
      props: SolidRouteProps;
      error?: RouteErrorProps;
    }
  | { state: "empty" | "loading" | "startup"; error?: RouteErrorProps };

type Presentation = { key: string; render: (presented: boolean) => RouteContent };

function RoutePresentation(props: {
  presentation?: boolean;
  presented?: boolean;
  renderValue: () => RouteContent;
  ref: (element: HTMLElement) => void;
}) {
  const value = createMemo(() => props.renderValue());
  const native = () => {
    const current = value();
    return "render" in current ? current : undefined;
  };
  const error = () => {
    const current = value();
    return "error" in current ? current.error : undefined;
  };
  const state = () => {
    const current = value();
    return "state" in current ? current.state : undefined;
  };
  const page = (
    <>
      <Show when={native()}>
        {(current) => (
          <ContentPresentation value={() => props.presented !== false}>
            <Show when={current().render} keyed>
              {(View) => (
                <View
                  data={current().props.data}
                  loaderPending={current().props.loaderPending}
                  presented={current().props.presented}
                />
              )}
            </Show>
          </ContentPresentation>
        )}
      </Show>
      <Show when={error()}>{(current) => <RouteError {...current()} />}</Show>
      <Show when={state() === "startup"}>
        <AgentStartupState />
      </Show>
      <Show when={state() === "loading"}>
        <LoadingState />
      </Show>
    </>
  );
  return (
    <Dynamic
      component={props.presentation ? "openclaw-route-presentation" : "openclaw-route-fragment"}
      ref={props.ref}
      style={{ display: props.presentation && !props.presented ? "none" : "contents" }}
      hidden={props.presentation ? !props.presented : undefined}
      inert={props.presentation ? !props.presented : undefined}
      aria-hidden={props.presentation ? (props.presented ? "false" : "true") : undefined}
    >
      {page}
    </Dynamic>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-router-outlet": HTMLAttributes<HTMLElement> & {
        "onOpenclaw-route-element"?: (event: RouteElementEvent) => void;
      };
      "openclaw-route-presentation": HTMLAttributes<HTMLElement>;
      "openclaw-route-fragment": HTMLAttributes<HTMLElement>;
    }
  }
}

/** Solid owns route presentation and retained page lifetimes. */
export function RouterOutlet(props: RouterOutletProps): SolidJSX.Element {
  const elements = new RouteElements();
  let host!: HTMLElement;
  let retainedRegion: HTMLElement | undefined;
  let transientRegion: HTMLElement | undefined;
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
  const outlet = createRouterOutletPresentation<
    ApplicationRouteMatch["routeId"],
    ApplicationContext,
    NonNullable<ApplicationRouteMatch["module"]>
  >(props);
  let committedSnapshot: ReturnType<typeof outlet.snapshot> | undefined;
  const retainedGate = createMcpAppUnmountGate<Presentation | null>(invalidate);
  const transientGate = createMcpAppUnmountGate<Presentation | null>(invalidate);
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
      .finally(() => {
        if (
          !disposed &&
          scopeRouter === router &&
          scopeOwner === scope &&
          scopeGeneration === currentGeneration
        ) {
          scopeRefreshing = false;
          invalidate();
        }
      })
      .catch(() => undefined);
  };

  const presentation = createMemo(() => {
    revision();
    const router = props.router;
    if (!router) {
      return {
        retained: null,
        transient: null,
        presented: false,
        waiting: false,
        settled: false,
        snapshot: outlet.snapshot(),
      };
    }
    synchronizeRetentionScope(router);
    const snapshot = outlet.snapshot();
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
    const renderTransient = (): RouteContent => {
      if (snapshot.startupPending) {
        return { state: "startup" };
      }
      if (isSessionRouteId(renderedMatch?.routeId) && !scopeReady) {
        return !retiredSession && renderedMatch?.error !== undefined
          ? {
              state: "empty",
              error: {
                router,
                retryContext,
                error: renderedMatch.error,
                routeId: renderedMatch.routeId,
              },
            }
          : { state: "loading" };
      }
      if (module?.retainOnNavigate && waiting) {
        if (renderedMatch?.routeId === "chat" && snapshot.settled?.routeId === "new-session") {
          return renderRouterOutlet(router, snapshot.settled, retryContext);
        }
        return { state: "loading" };
      }
      return renderRouterOutlet(router, renderedMatch, retryContext);
    };
    const retainedValue = retainedGate.render(
      retainedKey,
      () =>
        retained
          ? {
              key: retainedKey,
              render: (presented) => renderRouterOutlet(router, retained, retryContext, presented),
            }
          : null,
      () => (retainedRegion?.isConnected ? [retainedRegion] : []),
    );
    const transientValue = transientGate.render(
      transientKey,
      () => (presentRetained ? null : { key: transientKey, render: renderTransient }),
      () => (transientRegion?.isConnected ? [transientRegion] : []),
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
      snapshot,
    };
  });

  // Readiness must observe the DOM commit, not just the preceding presentation calculation.
  createEffect(presentation, (value) => {
    committedSnapshot = value.snapshot;
    committedSettled = value.settled;
    committedGeneration = generation;
    notify();
  });

  const isSettled = () =>
    !disposed &&
    host.isConnected &&
    outlet.isCurrent(committedSnapshot) &&
    committedGeneration === generation &&
    committedSettled;
  const settlePresentation = async (): Promise<boolean> => {
    while (true) {
      if (disposed || !host.isConnected) {
        return false;
      }
      // The island commits with Solid; descendants own their independent work.
      await Promise.resolve();
      if (disposed || !host.isConnected) {
        return false;
      }
      if (
        outlet.isCurrent(committedSnapshot) &&
        committedGeneration === generation &&
        !retainedGate.retiring &&
        !transientGate.retiring
      ) {
        return isSettled();
      }
      // Async render transactions may need a browser task before they can commit.
      await new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    }
  };

  onSettled(() => () => {
    disposed = true;
    notify();
  });

  return (
    <openclaw-router-outlet
      inert={props.inert}
      aria-disabled={props["aria-disabled"]}
      onOpenclaw-route-element={elements.register}
      ref={(element) => {
        host = element;
        const readinessHost = Object.defineProperties(element, {
          presentationSettled: { configurable: true, get: isSettled },
          settlePresentation: { configurable: true, value: settlePresentation },
          renderedElement: {
            configurable: true,
            value: elements.renderedElement.bind(elements),
          },
          renderedElements: {
            configurable: true,
            value: elements.renderedElements.bind(elements),
          },
        }) as ControlUiReadinessOutlet; // SAFETY: These descriptors define the outlet contract.
        // Publish this mount's element contract once, with its original ref callback.
        props.ref?.(readinessHost);
      }}
    >
      <Show when={presentation().retained?.key} keyed>
        {(_ownerKey) => (
          <RoutePresentation
            ref={(element) => (retainedRegion = element)}
            presentation
            presented={presentation().presented}
            renderValue={() =>
              presentation().retained?.render(presentation().presented) ?? { state: "empty" }
            }
          />
        )}
      </Show>
      <Show when={Boolean(presentation().transient)}>
        <RoutePresentation
          ref={(element) => (transientRegion = element)}
          renderValue={() => presentation().transient?.render(true) ?? { state: "empty" }}
        />
      </Show>
      <Show when={presentation().waiting}>
        <openclaw-route-fragment style={{ display: "contents" }}>
          <LoadingState />
        </openclaw-route-fragment>
      </Show>
    </openclaw-router-outlet>
  );
}
