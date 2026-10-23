import {
  postNativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { BrowserPanelHost } from "./browser-panel-operation-ownership.ts";

let presentationOrder = 0;

/** The web panel owns geometry and occlusion; native owns the actual views. */
export function createBrowserPanelNativePresentation(controller: {
  readonly host: Pick<
    BrowserPanelHost,
    "isConnected" | "browserPanelIsOpen" | "renderRoot" | "sessionKey"
  >;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly mode: "interact" | "annotate" | "inspect";
  reportError(error: unknown): void;
}) {
  // Every panel has a scope, including insecure HTTP origins without randomUUID.
  const scope = generateUUID();
  let presentedTabId: string | null = null;
  let lastPresented = 0;
  let stage: HTMLElement | null = null;
  let intersecting = true;
  let occluded = false;
  let frame: number | null = null;
  let lastPresentation: { key: string } | null = null;
  let connected = false;

  function hostElement(): Element | null {
    const root = controller.host.renderRoot;
    return root instanceof ShadowRoot ? root.host : root instanceof Element ? root : null;
  }

  function schedule(): void {
    if (!connected || frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      report();
    });
  }

  function canPresent(): boolean {
    return Boolean(
      connected &&
      controller.host.isConnected &&
      controller.host.browserPanelIsOpen() &&
      controller.native.activeTab &&
      controller.mode === "interact" &&
      !occluded &&
      intersecting,
    );
  }

  function report(): void {
    if (!connected) {
      return;
    }
    if (!stage || !canPresent()) {
      presentation.hide();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const host = hostElement();
    let hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    // document hit-testing stops at shadow hosts. Descend to distinguish this
    // panel from a dialog or another panel within the same application root.
    while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
      const inner = hit.shadowRoot.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      if (!inner || inner === hit) {
        break;
      }
      hit = inner;
    }
    let ancestor: Node | null = hit;
    while (ancestor && ancestor !== host) {
      ancestor = ancestor instanceof ShadowRoot ? ancestor.host : ancestor.parentNode;
    }
    if (!ancestor || rect.width <= 0 || rect.height <= 0) {
      presentation.hide();
      return;
    }
    send(controller.activeTargetId, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  function send(
    tabId: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const payload = {
      type: "present" as const,
      scope,
      tabId,
      rect,
      visible: Boolean(tabId),
    };
    const presentation = { key: JSON.stringify(payload) };
    if (presentation.key === lastPresentation?.key) {
      return;
    }
    lastPresentation = presentation;
    const sessionKey = controller.host.sessionKey;
    presentedTabId = tabId;
    if (tabId) {
      // Native resolves duplicate presentations of one tab in favor of the
      // most recent scope; this order also selects a popup's web presenter.
      lastPresented = ++presentationOrder;
    }
    void postNativeBrowserMessage(payload).then((reply) => {
      if (
        reply &&
        !reply.ok &&
        connected &&
        controller.host.sessionKey === sessionKey &&
        lastPresentation === presentation
      ) {
        controller.reportError(reply.error);
      }
    });
  }

  const presentation = {
    scope,
    get presentedTabId() {
      return presentedTabId;
    },
    get lastPresented() {
      return lastPresented;
    },
    mount(): () => void {
      connected = true;
      // Native responder focus can route back to this panel without DOM events.
      hostElement()?.setAttribute("data-native-browser-scope", scope);
      const stopOcclusion = subscribeNativeOverlayOcclusion(
        (value) => {
          occluded = value;
          if (value) {
            presentation.hide();
          }
          schedule();
        },
        () => stage?.getBoundingClientRect() ?? null,
      );
      presentation.update();
      return () => {
        presentation.hide();
        hostElement()?.removeAttribute("data-native-browser-scope");
        connected = false;
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        stopOcclusion();
        lastPresentation = null;
        void postNativeBrowserMessage({ type: "release-scope", scope });
      };
    },
    update(): void {
      if (!connected) {
        return;
      }
      if (!canPresent()) {
        presentation.hide();
      }
      schedule();
    },
    mountStage(element: HTMLElement): () => void {
      stage = element;
      intersecting = true;
      const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
      const intersection =
        typeof IntersectionObserver === "function"
          ? new IntersectionObserver(([entry]) => {
              intersecting = entry?.isIntersecting ?? intersecting;
              schedule();
            })
          : null;
      resize?.observe(stage);
      intersection?.observe(stage);
      const stopScroll = listen(document, "scroll", schedule, true);
      const stopResize = listen(window, "resize", schedule);
      presentation.update();
      return () => {
        presentation.hide();
        stage = null;
        resize?.disconnect();
        intersection?.disconnect();
        stopScroll();
        stopResize();
      };
    },
    renew(): void {
      // Explicit selection reclaims a tab that another panel scope may now own.
      lastPresentation = null;
      schedule();
    },
    hide(): void {
      if (connected) {
        send(null, null);
      }
    },
  };
  return presentation;
}
