import { LitElement } from "lit";
import type { ApplicationContext } from "./context.ts";
import {
  nativePanelBridge,
  NATIVE_PRESENTATION_REQUEST_EVENT,
  type NativePresentationState,
} from "./native-web-chrome.ts";

let nextGeneration = 0;

/** One shell owner waits for requests, shared loading UI, and committed render frames. */
export function startNativePresentation(context: {
  router: Pick<ApplicationContext["router"], "getState" | "subscribe">;
  gateway: Pick<ApplicationContext["gateway"], "snapshot">;
}) {
  let frame = 0;
  let quiet = 0;
  let disposed = false;
  let target = "";
  let state: NativePresentationState | undefined;
  const publish = () => {
    Object.assign(window, { __OPENCLAW_NATIVE_PRESENTATION__: state });
    nativePanelBridge()?.postMessage({ type: "openclaw-presentation-state", ...state });
  };
  const busy = (element: Element): boolean => {
    if (
      element instanceof HTMLElement &&
      (element.hidden || element.inert || getComputedStyle(element).display === "none")
    ) {
      return false;
    }
    if (
      element.matches(".skeleton, [aria-busy='true'], openclaw-panel-loading-skeleton") ||
      (element instanceof LitElement && element.isUpdatePending)
    ) {
      return true;
    }
    return [...element.children, ...(element.shadowRoot?.children ?? [])].some(busy);
  };
  const tick = () => {
    frame = 0;
    if (disposed || state?.phase !== "loading") {
      return;
    }
    const gateway = context.gateway.snapshot;
    const route = context.router.getState();
    const match = route.pendingMatches[0] ?? route.matches[0];
    const failed =
      gateway.lastError !== null || match?.error !== undefined || route.status === "notFound";
    const unsettled =
      !failed &&
      (gateway.phase !== "connected" ||
        route.status === "idle" ||
        route.status === "loading" ||
        !match?.module ||
        match.status !== "success" ||
        match.isFetching === "loader" ||
        route.pendingMatches.length > 0);
    quiet =
      unsettled ||
      gateway.client?.hasPendingRequests === true ||
      !document.body ||
      busy(document.body)
        ? 0
        : quiet + 1;
    // Secondary reads are admitted after two frames (scheduleControlUiAfterPaint).
    // The following quiet frame must also pass before an initially empty panel can reveal.
    if (quiet >= 3) {
      state.phase = "ready";
      publish();
    } else {
      frame = requestAnimationFrame(tick);
    }
  };
  const navigate = () => {
    const route = context.router.getState();
    const { pathname, search, hash } = route.status === "idle" ? window.location : route.location;
    const nextTarget = `${pathname}${search}${hash}`;
    if (nextTarget === target) {
      return;
    }
    target = nextTarget;
    state = { generation: ++nextGeneration, phase: "loading", pathname, search, hash };
    quiet = 0;
    publish();
    if (!frame) {
      frame = requestAnimationFrame(tick);
    }
  };
  const stopRouter = context.router.subscribe(navigate);
  window.addEventListener(NATIVE_PRESENTATION_REQUEST_EVENT, publish);
  navigate();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    stopRouter();
    window.removeEventListener(NATIVE_PRESENTATION_REQUEST_EVENT, publish);
    if (Reflect.get(window, "__OPENCLAW_NATIVE_PRESENTATION__") === state) {
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_PRESENTATION__");
    }
  };
}
