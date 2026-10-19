import { createSignal, onCleanup, untrack } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { NearViewportObserver } from "../near-viewport-observer.ts";

const REFRESH_LEAD_MS = 5_000;
type AppViewMode = "cached" | "refresh" | "expired";

function appViewKey(sessionKey: string, widget: BoardWidget): string {
  return `${sessionKey}\0${widget.name}\0${widget.revision}\0${widget.instanceId ?? ""}\0${widget.grantState}`;
}

function clearTimer(timer: number | undefined): undefined {
  if (timer !== undefined) {
    window.clearTimeout(timer);
  }
  return undefined;
}

type AppViewCallbacks = {
  appViewGeneration: () => number;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

type LifecycleHost = {
  active: () => boolean;
  connected: () => boolean;
  sessionKey: () => string;
  widget: () => BoardWidget | undefined;
};

export function createBoardMcpAppLifecycle(host: LifecycleHost) {
  let state: BoardWidgetAppViewState | undefined;
  let loading = false;
  let callbacks: AppViewCallbacks | undefined;
  let appViewGeneration = 0;
  let key = "";
  let generation = 0;
  let renewalTimer: number | undefined;
  let expiryTimer: number | undefined;
  const visibility = new NearViewportObserver(600, visibilityChanged);
  // The lease owner keeps synchronous admission; rendering receives the same facts together.
  const read = () => ({
    state,
    loading,
    active: host.active(),
    nearVisible: visibility.nearVisible,
  });
  // Later activity publishes with visibility from synchronize(), never independently.
  const initialActive = untrack(host.active);
  const [snapshot, setSnapshot] = createSignal<ReturnType<typeof read>>({
    state,
    loading,
    active: initialActive,
    nearVisible: visibility.nearVisible,
  });
  const publish = () => {
    if (host.connected()) {
      setSnapshot(read());
    }
  };

  function sync(): void {
    const widget = host.widget();
    if (!host.active() || !widget || widget.contentKind !== "mcp-app" || !callbacks) {
      renewalTimer = clearTimer(renewalTimer);
      return;
    }
    if (!visibility.nearVisible) {
      if (!loading) {
        renewalTimer = clearTimer(renewalTimer);
      }
      return;
    }
    if (!state && !loading) {
      void load(widget, callbacks, "cached");
    } else if (
      state?.status === "ready" &&
      !loading &&
      renewalTimer === undefined &&
      expiryTimer === undefined
    ) {
      scheduleRenewal(widget, callbacks, state, false);
    }
  }

  onCleanup(() => {
    visibility.disconnect();
    reset();
    callbacks = undefined;
  });

  function retry(): void {
    const widget = host.widget();
    if (host.active() && widget && callbacks) {
      void load(widget, callbacks, "refresh");
    }
  }

  function expire(): void {
    const widget = host.widget();
    if (!widget || !callbacks) {
      return;
    }
    const wasLoading = loading;
    state = { status: "stale", error: "MCP App view expired" };
    loading = false;
    publish();
    if (host.active() && !wasLoading) {
      void load(widget, callbacks, "expired");
    }
  }

  function reset(): void {
    clearTimers();
    generation += 1;
    key = "";
    appViewGeneration = 0;
    state = undefined;
    loading = false;
  }

  function clearTimers(): void {
    renewalTimer = clearTimer(renewalTimer);
    expiryTimer = clearTimer(expiryTimer);
  }

  function visibilityChanged(): void {
    queueMicrotask(() => {
      if (host.connected()) {
        publish();
        sync();
      }
    });
    if (!visibility.nearVisible && !loading) {
      renewalTimer = clearTimer(renewalTimer);
    }
  }

  async function load(
    widget: BoardWidget,
    requestCallbacks: AppViewCallbacks,
    mode: AppViewMode,
  ): Promise<void> {
    if (!host.active() || loading || !visibility.nearVisible) {
      return;
    }
    const requestKey = appViewKey(host.sessionKey(), widget);
    if (requestKey !== key) {
      return;
    }
    const requestGeneration = ++generation;
    const isCurrent = () => {
      const current = host.widget();
      return (
        host.connected() &&
        requestGeneration === generation &&
        key === requestKey &&
        current?.contentKind === "mcp-app" &&
        appViewKey(host.sessionKey(), current) === requestKey
      );
    };
    clearTimers();
    loading = true;
    const previousLease = mode === "refresh" && state?.status === "ready" ? state : null;
    if (mode === "expired") {
      state = undefined;
    }
    publish();
    if (previousLease) {
      expiryTimer = window.setTimeout(
        () => {
          expiryTimer = undefined;
          if (isCurrent()) {
            state = { status: "stale", error: "MCP App lease expired while renewing" };
            loading = false;
            publish();
          }
        },
        Math.max(0, previousLease.expiresAtMs - Date.now()),
      );
    }
    let appView: BoardWidgetAppViewState;
    try {
      appView = await (mode === "cached"
        ? requestCallbacks.widgetAppView(widget.name, widget.revision)
        : requestCallbacks.refreshWidgetAppView(widget.name, widget.revision));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      appView = {
        status: "stale",
        error: formatUiError(error),
      };
    }
    if (!isCurrent()) {
      return;
    }
    if (appView.status === "stale" && previousLease && previousLease.expiresAtMs > Date.now()) {
      loading = false;
      publish();
      return;
    }
    clearTimers();
    state = appView;
    loading = false;
    scheduleRenewal(widget, requestCallbacks, appView, mode !== "cached");
    publish();
  }

  function scheduleExpiry(widget: BoardWidget, appView: BoardWidgetAppViewState): void {
    if (appView.status !== "ready") {
      return;
    }
    expiryTimer = clearTimer(expiryTimer);
    const scheduledKey = key;
    expiryTimer = window.setTimeout(
      () => {
        expiryTimer = undefined;
        const current = host.widget();
        if (
          host.connected() &&
          key === scheduledKey &&
          current?.name === widget.name &&
          current.revision === widget.revision &&
          state?.status === "ready" &&
          state.viewId === appView.viewId &&
          state.expiresAtMs === appView.expiresAtMs
        ) {
          state = { status: "stale", error: "MCP App lease expired" };
          publish();
        }
      },
      Math.max(0, appView.expiresAtMs - Date.now()),
    );
  }

  function scheduleRenewal(
    widget: BoardWidget,
    requestCallbacks: AppViewCallbacks,
    appView: BoardWidgetAppViewState,
    renewed: boolean,
  ): void {
    renewalTimer = clearTimer(renewalTimer);
    if (appView.status !== "ready" || !host.active()) {
      return;
    }
    const scheduledKey = key;
    const delayMs = appView.expiresAtMs - Date.now() - REFRESH_LEAD_MS;
    if (!visibility.nearVisible) {
      if (renewed && delayMs <= 0) {
        scheduleExpiry(widget, appView);
      }
      return;
    }
    if (delayMs <= 0) {
      if (renewed) {
        scheduleExpiry(widget, appView);
      } else {
        void load(widget, requestCallbacks, "refresh");
      }
      return;
    }
    renewalTimer = window.setTimeout(() => {
      renewalTimer = undefined;
      const current = host.widget();
      if (
        host.connected() &&
        host.active() &&
        visibility.nearVisible &&
        key === scheduledKey &&
        current?.name === widget.name &&
        current.revision === widget.revision
      ) {
        void load(current, requestCallbacks, "refresh");
      }
    }, delayMs);
  }

  return {
    snapshot,
    synchronize(nextCallbacks: AppViewCallbacks | undefined, target: Element | null) {
      const widget = host.widget();
      callbacks = nextCallbacks;
      if (!widget || widget.contentKind !== "mcp-app" || !callbacks) {
        reset();
      } else {
        const nextKey = appViewKey(host.sessionKey(), widget);
        const nextGeneration = callbacks.appViewGeneration();
        if (nextKey !== key || nextGeneration !== appViewGeneration) {
          reset();
          key = nextKey;
          appViewGeneration = nextGeneration;
        }
      }
      if (!host.active()) {
        clearTimers();
      }
      if (target && host.active() && widget?.contentKind === "mcp-app") {
        visibility.observe(target);
      } else {
        visibility.disconnect();
      }
      sync();
      publish();
    },
    retry,
    expire,
  };
}
