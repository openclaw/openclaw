import {
  postNativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { BrowserPanelControllerHost } from "./browser-panel-operation-ownership.ts";

interface BrowserPanelNativePresentationHost {
  readonly host: Pick<
    BrowserPanelControllerHost,
    "isConnected" | "browserPanelIsOpen" | "renderRoot" | "sessionKey"
  >;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly mode: "interact" | "annotate" | "inspect";
  reportError(error: unknown): void;
}

let presentationOrder = 0;

/** The web panel owns geometry and occlusion; native owns the actual views. */
export class BrowserPanelNativePresentation {
  // Every panel builds one of these, including on insecure HTTP origins where
  // crypto.randomUUID is undefined; the helper falls back to getRandomValues.
  readonly scope = generateUUID();
  presentedTabId: string | null = null;
  lastPresented = 0;
  private stage: HTMLElement | null = null;
  private unsubscribeOcclusion?: () => void;
  private intersecting = true;
  private occluded = false;
  private frame: number | null = null;
  private lastPresentation: { key: string } | null = null;
  private connected = false;

  constructor(private readonly controller: BrowserPanelNativePresentationHost) {}

  private get hostElement(): Element | null {
    const root = this.controller.host.renderRoot;
    return root instanceof ShadowRoot ? root.host : root instanceof Element ? root : null;
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    // Native responder focus can route back to this panel without DOM events.
    this.hostElement?.setAttribute("data-native-browser-scope", this.scope);
    this.unsubscribeOcclusion = subscribeNativeOverlayOcclusion(
      (occluded) => {
        this.occluded = occluded;
        if (occluded) {
          this.hide();
        }
        this.schedule();
      },
      () => this.stage?.getBoundingClientRect() ?? null,
    );
    this.update();
  }

  disconnect(): void {
    this.hide();
    this.hostElement?.removeAttribute("data-native-browser-scope");
    this.connected = false;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.unsubscribeOcclusion?.();
    this.unsubscribeOcclusion = undefined;
    this.lastPresentation = null;
    void postNativeBrowserMessage({ type: "release-scope", scope: this.scope });
  }

  update(): void {
    if (!this.connected) {
      return;
    }
    if (!this.canPresent()) {
      this.hide();
    }
    this.schedule();
  }

  mountStage(stage: HTMLElement): () => void {
    this.stage = stage;
    this.intersecting = true;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(this.schedule) : null;
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            this.intersecting = entry?.isIntersecting ?? this.intersecting;
            this.schedule();
          })
        : null;
    resize?.observe(stage);
    intersection?.observe(stage);
    const stopScroll = listen(document, "scroll", this.schedule, true);
    const stopResize = listen(window, "resize", this.schedule);
    this.update();
    return () => {
      this.hide();
      this.stage = null;
      resize?.disconnect();
      intersection?.disconnect();
      stopScroll();
      stopResize();
    };
  }

  readonly schedule = (): void => {
    if (!this.connected || this.frame !== null) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.report();
    });
  };

  renew(): void {
    // Explicit selection reclaims a tab that another panel scope may now own.
    this.lastPresentation = null;
    this.schedule();
  }

  hide(): void {
    if (this.connected) {
      this.send(null, null);
    }
  }

  private canPresent(): boolean {
    return Boolean(
      this.connected &&
      this.controller.host.isConnected &&
      this.controller.host.browserPanelIsOpen() &&
      this.controller.native.activeTab &&
      this.controller.mode === "interact" &&
      !this.occluded &&
      this.intersecting,
    );
  }

  private report(): void {
    if (!this.connected) {
      return;
    }
    const stage = this.stage;
    if (!stage || !this.canPresent()) {
      this.hide();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const host = this.hostElement;
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
      this.hide();
      return;
    }
    this.send(this.controller.activeTargetId, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  private send(
    tabId: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const payload = {
      type: "present" as const,
      scope: this.scope,
      tabId,
      rect,
      visible: Boolean(tabId),
    };
    const presentation = { key: JSON.stringify(payload) };
    if (presentation.key === this.lastPresentation?.key) {
      return;
    }
    this.lastPresentation = presentation;
    const sessionKey = this.controller.host.sessionKey;
    this.presentedTabId = tabId;
    if (tabId) {
      // Native resolves duplicate presentations of one tab in favor of the
      // most recent scope; this order also selects a popup's web presenter.
      this.lastPresented = ++presentationOrder;
    }
    void postNativeBrowserMessage(payload).then((reply) => {
      if (
        reply &&
        !reply.ok &&
        this.connected &&
        this.controller.host.sessionKey === sessionKey &&
        this.lastPresentation === presentation
      ) {
        this.controller.reportError(reply.error);
      }
    });
  }
}
