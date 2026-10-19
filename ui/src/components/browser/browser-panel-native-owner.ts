import {
  hasNativeBrowserBridge,
  postNativeBrowserMessage,
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserMessage,
  type NativeBrowserState,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  readBrowserInspectedNode,
  type BrowserInspectedNode,
  type BrowserPanelTab,
} from "./browser-client.ts";
import type { BrowserPanelInputOwner } from "./browser-panel-input-owner.ts";
import { createBrowserPanelNativePresentation } from "./browser-panel-native-presentation.ts";
import type { BrowserPanelHost } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import {
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  loadBrowserPanelImage,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

type BrowserPanelNativeState = {
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  view: BrowserPanelView | null;
  mode: "interact" | "annotate" | "inspect";
  loading: boolean;
  errorText: string | null;
  pendingNewTab: boolean;
  urlDraft: string;
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
};

interface BrowserPanelNativeHost extends BrowserPanelNativeState {
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
  setState<Key extends keyof BrowserPanelNativeState>(
    key: Key,
    value: BrowserPanelNativeState[Key],
  ): void;
  selectTab(targetId: string): Promise<void>;
  syncUrlDraft(url: string): void;
  reportError(error: unknown): void;
  exitCaptureModes(): void;
}

const presenters = new Set<{
  includesTab(tab: NativeBrowserTab): boolean;
  presentation: ReturnType<typeof createBrowserPanelNativePresentation>;
}>();
const popupScopes = new Map<string, string>();

/** Project the native owner's retained tabs into this session's panel. */
export function createBrowserPanelNative(controller: BrowserPanelNativeHost) {
  const presentation = createBrowserPanelNativePresentation(controller);
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

  function acceptState(state: NativeBrowserState, activatePopups: boolean): void {
    const previous = new Set(nativeTabs().map((tab) => tab.id));
    const activeBefore = native.activeTab;
    allNativeTabs = state.tabs;
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
      if (!state.tabs.some((tab) => tab.id === id)) {
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
        acceptState(initial, false);
      }
      const stopState = subscribeNativeBrowserState((state) => acceptState(state, true));
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
          controller.reportError(reply.error);
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
