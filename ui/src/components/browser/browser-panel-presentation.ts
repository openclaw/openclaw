import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasNativeBrowserBridge } from "../../app/native-browser-bridge.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { LinkFaviconFetcher } from "../../pages/chat/link-favicon-cache.ts";
import { createDockLayout } from "../dock-layout.ts";
import { browserPanelLayout } from "../dock-panel-layout.ts";
import { notifyPanelHostedTabsChanged } from "../panel-hosted-tabs.ts";
import { createPanelPresentationLifecycle } from "../panel-presentation-lifecycle.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { browserRequestReferencedTabs, type BrowserDashboardTarget } from "./browser-client.ts";
import { createBrowserPanel, type BrowserPanelHost } from "./browser-panel-owner.ts";
import { browserPanelHostedTabs } from "./browser-panel-tabs.ts";
import {
  browserTabKey,
  readBrowserTabTarget,
  type BrowserTabSelection,
  type BrowserTabTarget,
} from "./browser-target.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

export type BrowserPanelInputs = {
  client: GatewayBrowserClient | null;
  available: boolean;
  remoteAvailable: boolean;
  suppressed: boolean;
  resourceBasePath: string;
  authToken: string | null;
  embedded: boolean;
  tabsInHeader: boolean;
  mobilePresentation?: boolean;
  fetchFavicon?: LinkFaviconFetcher;
  presented: boolean;
  refreshOnPresentation: boolean;
  sessionKey: string;
  sessionTabs: BrowserTabTarget[];
  preferredTab: BrowserTabSelection | undefined;
  fixedTab: BrowserTabTarget | undefined;
  dashboardTarget: BrowserDashboardTarget | undefined;
};

export type BrowserPanelPresentation = ReturnType<typeof createBrowserPanelPresentation>;
export type BrowserPanelMethods = Pick<
  BrowserPanelPresentation,
  "browserPanelIsOpen" | "toggle" | "handleToggleRequest" | "selectHostedTab" | "closeHostedTab"
>;
export type BrowserPanelElement = HTMLElement &
  BrowserPanelInputs &
  BrowserPanelMethods &
  Pick<BrowserPanelPresentation, "hostedTabs" | "activeHostedTabId" | "updateComplete">;

/** Keeps browser admission synchronous while Solid consumes its published presentation. */
export function createBrowserPanelPresentation(
  element: HTMLElement & BrowserPanelInputs,
  scheduleAfterRender: (callback: () => void) => void,
) {
  let activeSessionKey = "";
  let activeDashboardKey: string | undefined;
  let activeSessionTabsKey: string | undefined;
  let consumedPreferredRevision: string | undefined;
  let changes = new Set<keyof BrowserPanelInputs>([
    "client",
    "available",
    "embedded",
    "presented",
    "suppressed",
  ]);
  const lifecycle = createPanelPresentationLifecycle(scheduleAfterRender, () => {
    const changed = changes;
    changes = new Set();
    updatePresentation(changed);
  });
  let stopToggle: (() => void) | undefined;
  function syncToggleListener(): void {
    if (lifecycle.active() && !element.embedded) {
      stopToggle ??= listen(window, BROWSER_PANEL_TOGGLE_EVENT, (event) => {
        if (!element.embedded) {
          handleToggleRequest(event);
        }
      });
    } else {
      stopToggle?.();
      stopToggle = undefined;
    }
  }
  const publish = lifecycle.publish;
  const dockLayout = createDockLayout({
    notify: publish,
    isEmbedded: () => element.embedded,
    layout: browserPanelLayout,
    reservationPrefix: "browser",
    isAvailable: () => element.available,
  });
  const host: BrowserPanelHost = {
    get client() {
      return element.client;
    },
    get sessionKey() {
      return element.sessionKey;
    },
    get sessionTabs() {
      return element.sessionTabs;
    },
    get available() {
      return element.available;
    },
    get remoteAvailable() {
      return element.remoteAvailable;
    },
    get fixedTab() {
      return element.fixedTab;
    },
    get dashboardTarget() {
      return element.dashboardTarget;
    },
    get resourceBasePath() {
      return element.resourceBasePath;
    },
    get authToken() {
      return element.authToken;
    },
    get isConnected() {
      return lifecycle.active() && element.isConnected;
    },
    get renderRoot() {
      return element;
    },
    get updateComplete() {
      return lifecycle.updateComplete;
    },
    browserPanelIsOpen,
  };
  const browser = createBrowserPanel(host, publish);

  function updatePresentation(changed: ReadonlySet<keyof BrowserPanelInputs>): void {
    if (changed.has("suppressed")) {
      const restored = dockLayout.setSuppressed(element.suppressed);
      if (element.suppressed) {
        browser.suspendView();
      } else if (restored && browserPanelIsOpen()) {
        void browser.refreshAll();
      }
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const presentationChanged =
      element.embedded && (changed.has("embedded") || changed.has("presented"));
    const contextChanged = synchronizeBrowserContext();
    const sessionTabsKey =
      !element.dashboardTarget && element.sessionKey.trim()
        ? JSON.stringify(browserRequestReferencedTabs(element.sessionTabs).map(browserTabKey))
        : undefined;
    const sessionTabsChanged = activeSessionTabsKey !== sessionTabsKey;
    activeSessionTabsKey = sessionTabsKey;
    // Keep preferred metadata for the explicit handler to consume, but let the
    // pending toggle choose its route before any automatic follow or refresh.
    const followedPreferred = element.refreshOnPresentation && followPreferredTab();
    if (element.embedded) {
      if (
        !element.presented ||
        !element.available ||
        (!element.client && !hasNativeBrowserBridge())
      ) {
        if (presentationChanged || gatewayAvailabilityChanged) {
          browser.suspendView();
        }
      } else if (
        element.refreshOnPresentation &&
        !followedPreferred &&
        (contextChanged || presentationChanged || gatewayAvailabilityChanged || sessionTabsChanged)
      ) {
        void browser.refreshAll();
      }
    } else if (gatewayAvailabilityChanged) {
      if (!element.available && dockLayout.open) {
        // Surface disappeared (disconnect/scope loss): hide without persisting
        // so the open preference survives a reconnect.
        dockLayout.hideWithoutPersisting();
        browser.resetBrowserState();
      } else if (
        element.available &&
        (dockLayout.restoreOpenState() || (contextChanged && browserPanelIsOpen())) &&
        !followedPreferred
      ) {
        // Hello arrived after mount (or a reconnect): restore the persisted
        // open state now that the surface is actually available.
        void browser.refreshAll();
      }
    }
    browser.native.presentation.update();
    dockLayout.syncReservation();
    browser.input.paintOverlay();
    notifyPanelHostedTabsChanged(element, [
      browser.activeTargetId,
      browser.tabs.map((tab) => [tab.id, tab.kind, tab.title, tab.url, tab.favicon]),
    ]);
  }

  function synchronizeBrowserContext(): boolean {
    const clientChanged = browser.synchronizeClient();
    const sessionChanged = activeSessionKey !== element.sessionKey;
    const dashboardKey = JSON.stringify(element.dashboardTarget);
    const dashboardChanged = activeDashboardKey !== dashboardKey;
    if (sessionChanged || dashboardChanged) {
      activeSessionKey = element.sessionKey;
      activeDashboardKey = dashboardKey;
      browser.operations.resetRoute();
      browser.resetBrowserState();
    }
    if (clientChanged || sessionChanged || dashboardChanged) {
      browser.native.cancelPendingActivation();
      browser.native.cancelCapture();
      consumedPreferredRevision = undefined;
    }
    return clientChanged || sessionChanged || dashboardChanged;
  }

  function preferredRevision(): string | undefined {
    const preferred = preferredSelection();
    return preferred && readBrowserTabTarget(preferred.tab)
      ? JSON.stringify([browserTabKey(preferred.tab), preferred.revision])
      : undefined;
  }

  function preferredSelection(): BrowserTabSelection | undefined {
    return element.fixedTab
      ? { tab: element.fixedTab, revision: "dashboard" }
      : element.preferredTab;
  }

  function followPreferredTab(): boolean {
    const revision = preferredRevision();
    const preferred = preferredSelection();
    if (
      !browserPanelIsOpen() ||
      !element.available ||
      !element.client ||
      !preferred ||
      !revision ||
      revision === consumedPreferredRevision
    ) {
      return false;
    }
    consumedPreferredRevision = revision;
    const tab = readBrowserTabTarget(preferred.tab);
    if (tab) {
      // Session results own the panel route and view, not the user's physical browser focus.
      void browser.selectTab(tab.targetId, tab, { focusBrowserTab: false });
    }
    return true;
  }

  function browserPanelIsOpen(): boolean {
    return element.embedded ? element.presented && !element.suppressed : dockLayout.open;
  }

  function toggle(): void {
    if (!element.available) {
      return;
    }
    if (dockLayout.open) {
      closePanel();
    } else {
      dockLayout.setOpen(true);
      void browser.refreshAll();
    }
  }

  const handleToggleRequest = (event: Event): void => {
    if (element.fixedTab) {
      return;
    }
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as BrowserPanelToggleDetail) // SAFETY: shared panel event payload; consumed fields are validated below.
        : null;
    synchronizeBrowserContext();
    const browserTab = readBrowserTabTarget(detail?.browserTab);
    if (detail?.browserTab !== undefined && !browserTab) {
      return;
    }
    const normalizedRequestedUrl =
      typeof detail?.url === "string" ? normalizeBrowserUrlDraft(detail.url) : null;
    let shouldRefresh = true;
    if (element.embedded) {
      if (!browserPanelIsOpen() || detail?.open === false || !element.available) {
        return;
      }
    } else {
      if (detail?.dock === "right" || detail?.dock === "bottom") {
        dockLayout.setDock(detail.dock, false);
      }
      if (detail?.open === false) {
        closePanel();
        return;
      }
      if (!normalizedRequestedUrl && detail?.open !== true) {
        toggle();
        return;
      }
      if (!element.available) {
        return;
      }
      shouldRefresh = !dockLayout.open;
      dockLayout.setOpen(true);
    }
    if (normalizedRequestedUrl) {
      void browser.openUrl(normalizedRequestedUrl, {
        newTab: true,
        native: detail?.native,
      });
    } else if (browserTab) {
      // Consume the current result so it cannot replace this explicit card choice.
      consumedPreferredRevision = preferredRevision();
      void browser.selectTab(browserTab.targetId, browserTab);
    } else if (detail?.newTab === true) {
      browser.beginNewTab();
    } else if (shouldRefresh && !followPreferredTab()) {
      void browser.refreshAll();
    }
  };

  function closePanel(): void {
    browser.suspendView();
    dockLayout.setOpen(false);
  }
  return {
    inputs: element,
    browser,
    dockLayout,
    browserPanelIsOpen,
    toggle,
    handleToggleRequest,
    closePanel,
    selectHostedTab: (id: string) => void browser.selectTab(id),
    closeHostedTab: (id: string) => browser.closeTab(id),
    get hostedTabs() {
      return browserPanelHostedTabs(browser.tabs, element.ownerDocument);
    },
    get activeHostedTabId() {
      return browser.activeTargetId;
    },
    get updateComplete() {
      return lifecycle.updateComplete;
    },
    subscribe: lifecycle.subscribe,
    inputsChanged(key: keyof BrowserPanelInputs) {
      // Property setters are synchronous; do not leave a gap before the next Solid commit.
      if (key === "embedded") {
        syncToggleListener();
      }
      changes.add(key);
      publish();
    },
    attach() {
      // Native state must seed tabs before a restored dock can refresh them.
      const stopNative = browser.native.mount();
      lifecycle.connect();
      dockLayout.connect();
      syncToggleListener();
      // A takeover already owning the viewport suppresses the restored dock first.
      dockLayout.setSuppressed(element.suppressed);
      if (!element.embedded && dockLayout.open) {
        void browser.refreshAll();
      }
      // A retained owner must resume the view suspended by its previous root.
      changes.add("presented");
      publish();
      return () =>
        lifecycle.dispose(() => {
          browser.suspendView();
          syncToggleListener();
          dockLayout.dispose();
          stopNative?.();
        });
    },
  };
}
