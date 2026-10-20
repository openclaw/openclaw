import type { RouteMatch, Router, RouterState } from "@openclaw/uirouter";
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "../lib/gateway-availability.ts";

type Selection<TRouteId extends string, TModule, TData> = {
  status: RouterState<TRouteId, TModule, TData>["status"];
  active: RouteMatch<TRouteId, TModule, TData> | undefined;
  pending: RouteMatch<TRouteId, TModule, TData> | undefined;
};
type Snapshot<TRouteId extends string, TModule, TData> = Selection<TRouteId, TModule, TData> & {
  settled: RouteMatch<TRouteId, TModule, TData> | undefined;
  startupPending?: boolean;
};
type Inputs<TRouteId extends string, TLoadContext, TModule, TData> = {
  router?: Router<TRouteId, TLoadContext, TModule, TData>;
  onNotFound?: () => boolean | void;
  notFoundRecoveryReady?: boolean;
  retryContext?: TLoadContext;
  retryEnabled?: boolean;
};

export function selectRenderedRouteMatch<TRouteId extends string, TModule, TData>(
  active: RouteMatch<TRouteId, TModule, TData> | undefined,
  pending: RouteMatch<TRouteId, TModule, TData> | undefined,
): RouteMatch<TRouteId, TModule, TData> | undefined {
  const coldPending =
    pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
  return coldPending && active ? active : (pending ?? active);
}

/** Presentation timing belongs to this Solid owner; route loading stays with the router. */
export function createRouterOutletPresentation<
  TRouteId extends string,
  TLoadContext,
  TModule,
  TData = unknown,
>(props: Inputs<TRouteId, TLoadContext, TModule, TData>) {
  type OutletSnapshot = Snapshot<TRouteId, TModule, TData>;
  type OutletRouter = Inputs<TRouteId, TLoadContext, TModule, TData>["router"];
  const idle = (): OutletSnapshot => ({
    status: "idle",
    active: undefined,
    pending: undefined,
    settled: undefined,
  });
  let inputs: Inputs<TRouteId, TLoadContext, TModule, TData> = {};
  let router: OutletRouter;
  let stopRouter: (() => void) | undefined;
  let selection: Selection<TRouteId, TModule, TData> = idle();
  let published: OutletSnapshot & { source: OutletRouter } = { ...idle(), source: undefined };
  // Retention-scope navigation can notify synchronously inside the caller's render memo.
  const [snapshot, setSnapshot] = createSignal<OutletSnapshot>(published, { ownedWrite: true });
  let settled: OutletSnapshot["settled"];
  let notFoundActive = false;
  let notFoundDeclined = false;
  let notFoundGeneration = 0;
  let startupMatchId: string | undefined;
  let startupAttempt = 0;
  let startupTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;

  function publish() {
    const next = {
      source: router,
      ...selection,
      settled,
      startupPending: startupMatchId !== undefined,
    };
    if (
      published.source === next.source &&
      published.status === next.status &&
      published.active === next.active &&
      published.pending === next.pending &&
      published.settled === next.settled &&
      published.startupPending === next.startupPending
    ) {
      return;
    }
    // Readiness compares this receipt synchronously, before Solid commits the same object.
    published = next;
    setSnapshot(next);
  }
  function clearStartupRetry() {
    globalThis.clearTimeout(startupTimer);
    startupTimer = undefined;
    startupMatchId = undefined;
    startupAttempt = 0;
  }
  function updateStartupRetry() {
    const { retryEnabled, retryContext } = inputs;
    // A new destination cancels the old retry before its module finishes loading.
    const match = selection.pending ?? selection.active;
    if (match?.id !== startupMatchId) {
      clearStartupRetry();
    }
    if (retryEnabled === false || retryContext === undefined || !match) {
      clearStartupRetry();
      return;
    }
    if (match.status === "pending" || match.isFetching) {
      globalThis.clearTimeout(startupTimer);
      startupTimer = undefined;
      return;
    }
    if (!isAgentDatabaseInspectionPendingError(match.error)) {
      clearStartupRetry();
      return;
    }
    startupMatchId = match.id;
    if (startupTimer !== undefined) {
      return;
    }
    const source = router;
    startupTimer = globalThis.setTimeout(
      () => {
        startupTimer = undefined;
        if (
          props.router !== source ||
          props.retryContext !== retryContext ||
          props.retryEnabled === false
        ) {
          return;
        }
        void source?.revalidate(retryContext, match.routeId).catch(() => undefined);
      },
      resolveGatewayReadRetryDelayMs(match.error, startupAttempt++),
    );
  }
  function cancelNotFound() {
    notFoundGeneration += 1;
    notFoundActive = false;
    notFoundDeclined = false;
  }
  function updateNotFound() {
    if (selection.status !== "notFound") {
      if (notFoundActive) {
        cancelNotFound();
      }
      return;
    }
    if (notFoundActive) {
      return;
    }
    notFoundActive = true;
    const generation = ++notFoundGeneration;
    const source = router;
    queueMicrotask(() => {
      if (
        disposed ||
        props.router !== source ||
        generation !== notFoundGeneration ||
        selection.status !== "notFound"
      ) {
        return;
      }
      // Declined recovery waits for readiness rather than retrying on unrelated renders.
      notFoundDeclined = props.onNotFound?.() === false;
    });
  }
  function applySelection(next: Selection<TRouteId, TModule, TData>) {
    selection = next;
    if (next.status === "idle" || next.status === "notFound") {
      settled = undefined;
    } else {
      const rendered = selectRenderedRouteMatch(next.active, next.pending);
      if (rendered?.status === "success") {
        settled = rendered;
      } else if (
        rendered?.status === "error" ||
        rendered?.status === "notFound" ||
        rendered?.status === "redirected"
      ) {
        // A terminal destination must not revive the previously disposed page on retry.
        settled = undefined;
      }
    }
    updateStartupRetry();
    publish();
    updateNotFound();
  }
  function detach() {
    stopRouter?.();
    stopRouter = undefined;
    cancelNotFound();
    clearStartupRetry();
  }
  // Synchronize the external router subscription and its navigation recovery timers.
  createEffect(
    () => ({
      router: props.router,
      onNotFound: props.onNotFound,
      notFoundRecoveryReady: props.notFoundRecoveryReady,
      retryContext: props.retryContext,
      retryEnabled: props.retryEnabled,
    }),
    (next) => {
      if (
        inputs.retryContext !== next.retryContext ||
        (inputs.retryEnabled ?? true) !== (next.retryEnabled ?? true)
      ) {
        clearStartupRetry();
      }
      const recoveryBecameReady =
        inputs.notFoundRecoveryReady === false &&
        next.notFoundRecoveryReady !== false &&
        notFoundDeclined;
      inputs = next;
      if (router !== next.router) {
        detach();
        router = next.router;
        settled = undefined;
        const source = router;
        const refresh = () => {
          // Earlier subscribers can navigate reentrantly; their current destination wins.
          const state = source?.getState();
          applySelection(
            state
              ? { status: state.status, active: state.matches[0], pending: state.pendingMatches[0] }
              : idle(),
          );
        };
        refresh();
        stopRouter = source?.subscribe(refresh);
      } else {
        updateStartupRetry();
        publish();
        if (recoveryBecameReady && selection.status === "notFound") {
          cancelNotFound();
          updateNotFound();
        }
      }
    },
  );
  onCleanup(() => {
    disposed = true;
    detach();
  });
  const empty = idle();
  return {
    snapshot: (): OutletSnapshot => {
      snapshot();
      // Subscribe even before binding; reentrant navigation reads the latest receipt.
      return props.router === router ? published : empty;
    },
    isCurrent: (value: OutletSnapshot | undefined) =>
      props.router === router && value === published,
  };
}
