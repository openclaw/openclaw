import { LitElement } from "lit";
import type { ApplicationContext } from "./context.ts";
import {
  nativePanelBridge,
  NATIVE_PRESENTATION_REQUEST_EVENT,
  NATIVE_PRESENTATION_STATE_EVENT,
  type NativePresentationState,
} from "./native-web-chrome.ts";

// Only missing initial content holds a route. Empty/error states remove this
// marker; background refreshes after the first ready publication stay visible.
const PENDING_ATTRIBUTE = "data-openclaw-presentation-pending";
let currentOwner: object | undefined;
let nextGeneration = 0;

/** Reports committed content, including nested loading states, without waiting for a visible frame. */
export function startNativePresentation(context: {
  router: Pick<ApplicationContext["router"], "getState" | "subscribe">;
  gateway: Pick<ApplicationContext["gateway"], "snapshot" | "subscribe">;
}): () => void {
  const owner = {};
  currentOwner = owner;
  let disposed = false;
  let generation = 0;
  let revision = 0;
  let checking = false;
  let target = "";
  let phase: NativePresentationState["phase"] = "loading";
  let location = {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
  const observed = new Set<Node>();
  const observer = new MutationObserver(() => schedule());

  const observe = (node: Node) => {
    if (observed.has(node)) {
      return;
    }
    observed.add(node);
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [PENDING_ATTRIBUTE, "hidden", "inert", "style"],
    });
  };
  const publish = () => {
    if (disposed || currentOwner !== owner) {
      return;
    }
    const state: NativePresentationState = { generation, phase, ...location };
    Object.assign(window, { __OPENCLAW_NATIVE_PRESENTATION__: state });
    nativePanelBridge()?.postMessage({ type: "openclaw-presentation-state", ...state });
    window.dispatchEvent(new CustomEvent(NATIVE_PRESENTATION_STATE_EVENT, { detail: state }));
  };
  const inspect = (element: Element, updates: Promise<boolean>[]): boolean => {
    if (
      element instanceof HTMLElement &&
      (element.hidden || element.inert || getComputedStyle(element).display === "none")
    ) {
      return false;
    }
    let pending = element.hasAttribute(PENDING_ATTRIBUTE);
    if (element instanceof LitElement && element.isUpdatePending) {
      updates.push(element.updateComplete);
    }
    const roots: (Element | ShadowRoot)[] = [element];
    if (element.shadowRoot) {
      observe(element.shadowRoot);
      roots.push(element.shadowRoot);
    }
    for (const root of roots) {
      for (const child of root.children) {
        pending = inspect(child, updates) || pending;
      }
    }
    return pending;
  };
  const check = async () => {
    const capturedRevision = revision;
    const capturedGeneration = generation;
    try {
      const root = document.body;
      const gateway = context.gateway.snapshot;
      const route = context.router.getState();
      const match = route.pendingMatches[0] ?? route.matches[0];
      const failedConnection = gateway.lastError !== null;
      const failed = failedConnection || match?.error !== undefined || route.status === "notFound";
      if (
        !root ||
        (!failed && gateway.phase !== "connected") ||
        (!failed &&
          (!match ||
            match.module === undefined ||
            match.status !== "success" ||
            route.status === "idle" ||
            route.status === "pending" ||
            route.pendingMatches.length > 0 ||
            match.isFetching === "loader"))
      ) {
        return;
      }
      const updates: Promise<boolean>[] = [];
      const pending = inspect(root, updates);
      await Promise.allSettled(updates);
      if (
        disposed ||
        currentOwner !== owner ||
        capturedRevision !== revision ||
        capturedGeneration !== generation ||
        pending
      ) {
        return;
      }
      if (updates.length > 0) {
        revision += 1;
        return;
      }
      phase = "ready";
      observer.disconnect();
      observed.clear();
      publish();
    } finally {
      checking = false;
      if (!disposed && phase === "loading" && capturedRevision !== revision) {
        schedule();
      }
    }
  };
  function schedule() {
    revision += 1;
    if (disposed || phase === "ready" || checking) {
      return;
    }
    checking = true;
    queueMicrotask(() => void check());
  }
  const routeChanged = () => {
    const state = context.router.getState();
    const requested = state.status === "idle" ? window.location : state.location;
    const next = new URL(window.location.href);
    next.pathname = requested.pathname;
    next.search = requested.search;
    next.hash = requested.hash;
    const nextTarget = JSON.stringify([next.pathname, next.search, next.hash]);
    if (nextTarget !== target) {
      target = nextTarget;
      location = { pathname: next.pathname, search: next.search, hash: next.hash };
      generation = ++nextGeneration;
      phase = "loading";
      observe(document.documentElement);
      publish();
    }
    schedule();
  };
  const stopRouter = context.router.subscribe(routeChanged);
  const stopGateway = context.gateway.subscribe(() => schedule());
  const requestPresentation = () => {
    publish();
    schedule();
  };
  window.addEventListener(NATIVE_PRESENTATION_REQUEST_EVENT, requestPresentation);
  routeChanged();
  return () => {
    disposed = true;
    observer.disconnect();
    stopRouter();
    stopGateway();
    window.removeEventListener(NATIVE_PRESENTATION_REQUEST_EVENT, requestPresentation);
    if (currentOwner === owner) {
      currentOwner = undefined;
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_PRESENTATION__");
    }
  };
}
