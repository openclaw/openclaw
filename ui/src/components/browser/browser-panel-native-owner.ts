import {
  hasNativeBrowserBridge,
  postNativeBrowserMessage,
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { observeDocumentScroll } from "../../lib/reactive/document-scroll.ts";
import { observeIntersection, observeResize } from "../../lib/reactive/observers.ts";
import { observeWindowResize } from "../../lib/reactive/window-resize.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { readBrowserInspectedNode, type BrowserPanelTab } from "./browser-client.ts";
import type { BrowserPanelInputOwner } from "./browser-panel-input-owner.ts";
import type { BrowserPanelHost } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import type { BrowserPanelStateWriter } from "./browser-panel-state.ts";
import {
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  loadBrowserPanelImage,
} from "./browser-panel-surface.ts";

interface BrowserPanelNativeHost extends BrowserPanelStateWriter<
  | "tabs"
  | "activeTargetId"
  | "view"
  | "mode"
  | "loading"
  | "errorText"
  | "pendingNewTab"
  | "urlDraft"
  | "inspected"
  | "inspectPointer"
> {
  readonly host: Pick<
    BrowserPanelHost,
    | "isConnected"
    | "browserPanelIsOpen"
    | "renderRoot"
    | "updateComplete"
    | "sessionKey"
    | "fixedTab"
  >;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly addressInput?: HTMLInputElement;
  readonly pendingInput: Pick<BrowserPanelPendingInput, "queueInspection">;
  readonly input: Pick<BrowserPanelInputOwner, "paintOverlay" | "elements">;
  selectTab(targetId: string): Promise<void>;
  syncUrlDraft(url: string): void;
  reportError(error: unknown, retry?: () => Promise<unknown>): void;
  exitCaptureModes(): void;
}

let presentationOrder = 0;

const presenters = new Set<{
  includesTab(tab: NativeBrowserTab): boolean;
  presentation: BrowserPanelNative["presentation"];
}>();
const popupScopes = new Map<string, string>();

/** Project the native owner's retained tabs into this session's panel. */
export function createBrowserPanelNative(controller: BrowserPanelNativeHost) {
  // The web panel owns geometry and occlusion; native owns the actual views.
  // Every panel has a scope, including insecure HTTP origins without randomUUID.
  const scope = generateUUID();
  let presentedTabId: string | null = null;
  let lastPresented = 0;
  let presentationStage: HTMLElement | null = null;
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
    if (!presentationStage || !canPresent()) {
      presentation.hide();
      return;
    }
    const rect = presentationStage.getBoundingClientRect();
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
        () => presentationStage?.getBoundingClientRect() ?? null,
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
      presentationStage = element;
      intersecting = true;
      const stopSize =
        typeof ResizeObserver === "function" ? observeResize([element], schedule) : undefined;
      const stopIntersection =
        typeof IntersectionObserver === "function"
          ? observeIntersection([element], ([entry]) => {
              intersecting = entry?.isIntersecting ?? intersecting;
              schedule();
            })
          : undefined;
      const stopScroll = observeDocumentScroll(document, schedule);
      const stopResize = observeWindowResize(window, schedule);
      presentation.update();
      return () => {
        presentation.hide();
        presentationStage = null;
        stopSize?.();
        stopIntersection?.();
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

  const presenterEntry = { includesTab, presentation };
  let allNativeTabs: NativeBrowserTab[] = [];
  let pendingActivation: string | null = null;
  let pendingCommand: NativeBrowserMessage | null = null;
  /** New-tab request whose address field should be cleared and focused once it is selected. */
  let pendingAddressFocus: string | null = null;
  let captureGeneration = 0;
  let inspectionGeneration = 0;

  function includesTab(tab: NativeBrowserTab): boolean {
    return (
      !controller.host.fixedTab &&
      (tab.sessionKey === undefined || tab.sessionKey === controller.host.sessionKey)
    );
  }

  function nativeTabs(): NativeBrowserTab[] {
    return allNativeTabs.filter((tab) => includesTab(tab));
  }

  function acceptTabs(tabs: NativeBrowserTab[], activatePopups: boolean): void {
    const previous = new Set(nativeTabs().map((tab) => tab.id));
    const activeBefore = native.activeTab;
    allNativeTabs = tabs;
    controller.setState("tabs", native.mergeRemoteTabs(controller.tabs));
    const view = controller.view;
    if (
      view?.kind === "native" &&
      nativeTabs().find((tab) => tab.id === view.targetId)?.url !== view.url
    ) {
      controller.exitCaptureModes();
      controller.setState("view", null);
    }
    for (const id of popupScopes.keys()) {
      if (!tabs.some((tab) => tab.id === id)) {
        popupScopes.delete(id);
      }
    }
    for (const tab of nativeTabs()) {
      if (tab.id === pendingActivation) {
        pendingActivation = null;
        void controller.selectTab(tab.id).then(() => {
          if (pendingAddressFocus === tab.id) {
            focusAddress(tab.id);
          }
        });
      } else if (activatePopups && tab.openedBy === "native" && !previous.has(tab.id)) {
        if (!popupScopes.has(tab.id)) {
          const eligible = [...presenters]
            .filter((presenter) => presenter.includesTab(tab))
            .toSorted((a, b) => b.presentation.lastPresented - a.presentation.lastPresented);
          const owner =
            eligible.find(
              (presenter) => presenter.presentation.presentedTabId === tab.openerTabId,
            ) ?? eligible.find((presenter) => presenter.presentation.lastPresented > 0);
          if (owner) {
            popupScopes.set(tab.id, owner.presentation.scope);
          }
        }
        if (popupScopes.get(tab.id) === presentation.scope) {
          void controller.selectTab(tab.id);
        }
      }
    }
    const firstNative = nativeTabs()[0];
    if (activeBefore && !native.activeTab) {
      const next = controller.tabs[0];
      controller.setState("activeTargetId", null);
      controller.setState("view", null);
      controller.exitCaptureModes();
      // A pending open selects its own tab when its state lands; an automatic
      // fallback would cancel that activation and strand the newer request.
      if (next && !pendingActivation) {
        void controller.selectTab(next.id);
      } else if (!next) {
        // The closed tab's address must not linger in the empty panel.
        controller.syncUrlDraft("");
      }
    } else if (!controller.activeTargetId && !pendingActivation && firstNative) {
      void controller.selectTab(firstNative.id);
    }
    const active = native.activeTab;
    if (active) {
      controller.syncUrlDraft(active.url);
      if (controller.mode === "interact") {
        controller.setState("loading", active.loading);
      }
    }
    presentation.update();
  }

  function focusAddress(tabId: string): void {
    if (controller.activeTargetId !== tabId) {
      return;
    }
    pendingAddressFocus = null;
    if (controller.host.isConnected && controller.host.browserPanelIsOpen()) {
      controller.setState("urlDraft", "");
      controller.addressInput?.focus();
    }
  }

  const native = {
    presentation,
    get activeTab(): NativeBrowserTab | undefined {
      return nativeTabs().find((tab) => tab.id === controller.activeTargetId);
    },
    get tabs(): BrowserPanelTab[] {
      return nativeTabs().map((tab) =>
        Object.assign({}, tab, { targetId: tab.id, kind: "native" as const }),
      );
    },
    mount(): (() => void) | undefined {
      if (!hasNativeBrowserBridge()) {
        return undefined;
      }
      presenters.add(presenterEntry);
      const initial = readNativeBrowserState();
      if (initial) {
        acceptTabs(initial.tabs, false);
      }
      const stopState = subscribeNativeBrowserState((state) => acceptTabs(state.tabs, true));
      const stopPresentation = presentation.mount();
      return () => {
        stopState();
        presenters.delete(presenterEntry);
        native.cancelPendingActivation();
        native.cancelCapture();
        stopPresentation();
      };
    },
    mergeRemoteTabs(remote: BrowserPanelTab[]): BrowserPanelTab[] {
      return [...native.tabs, ...remote.filter((tab) => tab.kind !== "native")];
    },
    async send(request: NativeBrowserMessage): Promise<boolean> {
      const sessionKey = controller.host.sessionKey;
      const activeTargetId = controller.activeTargetId;
      const generation = captureGeneration;
      pendingCommand = request;
      const reply = await postNativeBrowserMessage(request);
      if (pendingCommand !== request) {
        return false;
      }
      pendingCommand = null;
      if (
        captureGeneration !== generation ||
        !controller.host.isConnected ||
        !controller.host.browserPanelIsOpen() ||
        controller.host.sessionKey !== sessionKey ||
        controller.activeTargetId !== activeTargetId
      ) {
        return false;
      }
      if (reply && !reply.ok) {
        controller.reportError(reply.error);
      } else if (reply?.ok && request.type === "close") {
        // The native close commits before its scheduled state push. Publish the
        // acknowledged removal before callers decide whether to close the panel.
        acceptTabs(
          allNativeTabs.filter((tab) => tab.id !== request.tabId),
          false,
        );
      }
      return reply?.ok === true;
    },
    /**
     * A selection supersedes any in-flight open. Selecting a different tab also
     * drops a pending address focus; selecting the awaited tab keeps it.
     */
    cancelPendingActivation(selectedTabId?: string): void {
      pendingActivation = null;
      pendingCommand = null;
      if (pendingAddressFocus !== selectedTabId) {
        pendingAddressFocus = null;
      }
    },
    /**
     * Resolves with the tab this request still owns once it is selected, or null
     * when the request was superseded, failed, or its activation already landed
     * through a state push (the push path finishes any pending address focus).
     */
    async open(url: string, newTab: boolean, focusAfterOpen = false): Promise<string | null> {
      controller.setState("errorText", null);
      controller.setState("pendingNewTab", false);
      const active = native.activeTab;
      if (!newTab && active) {
        const tabId = active.id;
        controller.exitCaptureModes();
        return (await native.send({ type: "navigate", tabId, url })) ? tabId : null;
      }
      native.cancelPendingActivation();
      const tabId = `mac-${generateUUID()}`;
      pendingActivation = tabId;
      pendingAddressFocus = focusAfterOpen ? tabId : null;
      const reply = await postNativeBrowserMessage({
        type: "open",
        tabId,
        url,
        sessionKey: controller.host.sessionKey,
        activate: true,
      });
      if (pendingActivation !== tabId) {
        return null;
      }
      if (!reply?.ok || !reply.tabId) {
        native.cancelPendingActivation();
        if (reply && !reply.ok) {
          controller.reportError(reply.error, () => native.open(url, newTab, focusAfterOpen));
        }
        return null;
      }
      pendingActivation = reply.tabId;
      if (focusAfterOpen) {
        pendingAddressFocus = reply.tabId;
      }
      if (nativeTabs().some((tab) => tab.id === reply.tabId)) {
        pendingActivation = null;
        await controller.selectTab(reply.tabId);
        presentation.renew();
        return reply.tabId;
      }
      return null;
    },
    async beginNewTab(): Promise<void> {
      const tabId = await native.open("about:blank", true, true);
      if (!tabId || pendingAddressFocus !== tabId) {
        return;
      }
      await controller.host.updateComplete;
      focusAddress(tabId);
    },
    cancelCapture(): void {
      captureGeneration += 1;
      inspectionGeneration += 1;
    },
    async capture(mode: "annotate" | "inspect"): Promise<void> {
      const tab = native.activeTab;
      if (!tab) {
        return;
      }
      const generation = ++captureGeneration;
      controller.setState("loading", true);
      const current = () =>
        generation === captureGeneration &&
        controller.host.isConnected &&
        controller.host.browserPanelIsOpen() &&
        native.activeTab?.id === tab.id &&
        native.activeTab?.url === tab.url;
      try {
        const reply = await postNativeBrowserMessage({ type: "snapshot", tabId: tab.id });
        if (!current()) {
          return;
        }
        if (
          !reply?.ok ||
          typeof reply.dataUrl !== "string" ||
          typeof reply.cssWidth !== "number" ||
          typeof reply.cssHeight !== "number"
        ) {
          if (reply && !reply.ok) {
            controller.reportError(reply.error);
          }
          return;
        }
        const image = await loadBrowserPanelImage(reply.dataUrl);
        if (!current()) {
          return;
        }
        controller.setState("view", {
          kind: "native",
          targetId: tab.id,
          dataUrl: reply.dataUrl,
          image,
          url: tab.url,
          metrics: {
            cssWidth: reply.cssWidth,
            cssHeight: reply.cssHeight,
            title: tab.title,
            url: tab.url,
          },
        });
        controller.setState("mode", mode);
        presentation.hide();
      } catch (error) {
        if (current()) {
          controller.reportError(error);
        }
      } finally {
        if (current()) {
          controller.setState("loading", false);
        }
      }
    },
    inspect(event: PointerEvent): void {
      const tab = native.activeTab;
      const view = controller.view;
      const stage = controller.input.elements.stage ?? null;
      const point = browserPanelRemotePoint(stage, event, view);
      const normalized = browserPanelNormalizedPoint(stage, event);
      if (
        !tab ||
        view?.kind !== "native" ||
        view.targetId !== tab.id ||
        view.url !== tab.url ||
        !point ||
        !normalized ||
        controller.mode !== "inspect"
      ) {
        return;
      }
      const generation = ++inspectionGeneration;
      const current = () =>
        generation === inspectionGeneration &&
        controller.host.isConnected &&
        controller.host.browserPanelIsOpen() &&
        native.activeTab?.id === tab.id &&
        native.activeTab?.url === view.url &&
        controller.view === view &&
        controller.mode === "inspect";
      controller.setState("inspectPointer", normalized);
      controller.setState("inspected", null);
      controller.pendingInput.queueInspection(120, current, () => {
        void postNativeBrowserMessage({
          type: "inspect",
          tabId: tab.id,
          x: point.x,
          y: point.y,
        }).then((reply) => {
          if (!current()) {
            return;
          }
          if (reply && !reply.ok) {
            controller.reportError(reply.error);
          } else if (reply?.ok && "node" in reply) {
            controller.setState("inspected", readBrowserInspectedNode(reply.node));
            controller.input.paintOverlay();
          }
        });
      });
    },
  };
  return native;
}

export type BrowserPanelNative = ReturnType<typeof createBrowserPanelNative>;
