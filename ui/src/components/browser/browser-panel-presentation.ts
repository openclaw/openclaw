import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasNativeBrowserBridge } from "../../app/native-browser-bridge.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import { browserPanelLayout } from "../dock-panel-layout.ts";
import { notifyPanelHostedTabsChanged } from "../panel-hosted-tabs.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { SolidPanelController } from "../solid-panel-controller.ts";
import { browserRequestReferencedTabs, type BrowserDashboardTarget } from "./browser-client.ts";
import {
  BrowserPanelController,
  type BrowserPanelControllerHost,
} from "./browser-panel-controller.ts";
import { browserPanelHostedTabs } from "./browser-panel-tabs.ts";
import {
  browserTabKey,
  readBrowserTabTarget,
  type BrowserTabSelection,
  type BrowserTabTarget,
} from "./browser-target.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

export class BrowserPanelPresentation
  extends SolidPanelController
  implements BrowserPanelControllerHost
{
  /** Gateway client used for browser.request RPCs; null until connected. */
  client: GatewayBrowserClient | null = null;
  /** Whether the connected gateway advertises browser.request to this operator. */
  available = false;
  /** Gateway browser features remain separately gated on native hosts. */
  remoteAvailable = true;
  /** Full-page route takeovers (settings) own the viewport; the dock hides while one renders. */
  suppressed = false;
  /** Gateway HTTP resource mount used for the authenticated media fetch. */
  resourceBasePath = "";
  /** Bearer credential for the assistant-media screenshot fetch. */
  authToken: string | null = null;
  /** Hosted by the chat side panel, which owns visibility and geometry. */
  embedded = false;
  /** The hosting side-panel header presents this panel's tabs. */
  tabsInHeader = false;
  /** This embedded instance is the active pane's visible Browser presenter. */
  presented = false;
  /** Whether presentation owns initial work instead of a pending explicit toggle. */
  refreshOnPresentation = true;

  sessionKey = "";
  sessionTabs: BrowserTabTarget[] = [];
  preferredTab?: BrowserTabSelection;
  /** A dashboard presents only its owned remote tab; its owner controls removal and restart. */
  fixedTab?: BrowserTabTarget;
  dashboardTarget?: BrowserDashboardTarget;

  private activeSessionKey = "";
  private activeDashboardKey: string | undefined;
  private activeSessionTabsKey: string | undefined;
  private consumedPreferredRevision?: string;
  readonly browserPanelController = new BrowserPanelController(this);
  readonly dockLayout = new DockLayoutController(this, {
    layout: browserPanelLayout,
    reservationPrefix: "browser",
    isAvailable: () => this.available,
  });
  private viewportResizeObserver: ResizeObserver | null = null;
  private observedViewportElement: Element | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.embedded) {
      window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
    }
    // A settings takeover can already own the viewport when the panel mounts.
    // Suppress before the restored open state refreshes a dock nobody can see.
    this.dockLayout.setSuppressed(this.suppressed);
    if (!this.embedded && this.dockLayout.open) {
      void this.browserPanelController.refreshAll();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.observedViewportElement = null;
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("embedded")) {
      if (this.embedded) {
        window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      } else {
        window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      }
    }
    if (changed.has("suppressed")) {
      const restored = this.dockLayout.setSuppressed(this.suppressed);
      if (this.suppressed) {
        this.browserPanelController.suspendView();
      } else if (restored && this.browserPanelIsOpen()) {
        void this.browserPanelController.refreshAll();
      }
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const presentationChanged =
      this.embedded && (changed.has("embedded") || changed.has("presented"));
    const contextChanged = this.synchronizeBrowserContext();
    const sessionTabsKey =
      !this.dashboardTarget && this.sessionKey.trim()
        ? JSON.stringify(browserRequestReferencedTabs(this.sessionTabs).map(browserTabKey))
        : undefined;
    const sessionTabsChanged = this.activeSessionTabsKey !== sessionTabsKey;
    this.activeSessionTabsKey = sessionTabsKey;
    // Keep preferred metadata for the explicit handler to consume, but let the
    // pending toggle choose its route before any automatic follow or refresh.
    const followedPreferred = this.refreshOnPresentation && this.followPreferredTab();
    if (this.embedded) {
      if (!this.presented || !this.available || (!this.client && !hasNativeBrowserBridge())) {
        if (presentationChanged || gatewayAvailabilityChanged) {
          this.browserPanelController.suspendView();
        }
      } else if (
        this.refreshOnPresentation &&
        !followedPreferred &&
        (contextChanged || presentationChanged || gatewayAvailabilityChanged || sessionTabsChanged)
      ) {
        void this.browserPanelController.refreshAll();
      }
    } else if (gatewayAvailabilityChanged) {
      if (!this.available && this.dockLayout.open) {
        // Surface disappeared (disconnect/scope loss): hide without persisting
        // so the open preference survives a reconnect.
        this.dockLayout.hideWithoutPersisting();
        this.browserPanelController.resetBrowserState();
      } else if (
        this.available &&
        (this.dockLayout.restoreOpenState() || (contextChanged && this.browserPanelIsOpen())) &&
        !followedPreferred
      ) {
        // Hello arrived after mount (or a reconnect): restore the persisted
        // open state now that the surface is actually available.
        void this.browserPanelController.refreshAll();
      }
    }
    this.browserPanelController.native.presentation.update();
    this.dockLayout.syncReservation();
    this.browserPanelController.input.paintOverlay();
    const viewportElement = this.renderRoot.querySelector(".bp-viewport");
    if (viewportElement !== this.observedViewportElement) {
      // The viewport is transient while the dock opens, closes, or becomes unavailable.
      this.viewportResizeObserver?.disconnect();
      this.observedViewportElement = viewportElement;
      if (viewportElement && typeof ResizeObserver === "function") {
        this.viewportResizeObserver ??= new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            this.browserPanelController.handleViewportResize(
              entry.contentRect.width,
              entry.contentRect.height,
            );
          }
        });
        this.viewportResizeObserver.observe(viewportElement);
      }
    }
    const controller = this.browserPanelController;
    notifyPanelHostedTabsChanged(this.element, [
      controller.activeTargetId,
      controller.tabs.map((tab) => [tab.id, tab.kind, tab.title, tab.url, tab.favicon]),
    ]);
  }

  get hostedTabs() {
    return browserPanelHostedTabs(this.browserPanelController.tabs);
  }

  get activeHostedTabId(): string | null {
    return this.browserPanelController.activeTargetId;
  }

  selectHostedTab(id: string): void {
    void this.browserPanelController.selectTab(id);
  }

  closeHostedTab(id: string): Promise<void> {
    return this.browserPanelController.closeTab(id);
  }

  private synchronizeBrowserContext(): boolean {
    const clientChanged = this.browserPanelController.synchronizeClient();
    const sessionChanged = this.activeSessionKey !== this.sessionKey;
    const dashboardKey = JSON.stringify(this.dashboardTarget);
    const dashboardChanged = this.activeDashboardKey !== dashboardKey;
    if (sessionChanged || dashboardChanged) {
      this.activeSessionKey = this.sessionKey;
      this.activeDashboardKey = dashboardKey;
      this.browserPanelController.operations.resetRoute();
      this.browserPanelController.resetBrowserState();
    }
    if (clientChanged || sessionChanged || dashboardChanged) {
      this.browserPanelController.native.cancelPendingActivation();
      this.browserPanelController.native.cancelCapture();
      this.consumedPreferredRevision = undefined;
    }
    return clientChanged || sessionChanged || dashboardChanged;
  }

  private preferredRevision(): string | undefined {
    const preferred = this.preferredSelection;
    return preferred && readBrowserTabTarget(preferred.tab)
      ? JSON.stringify([browserTabKey(preferred.tab), preferred.revision])
      : undefined;
  }

  private get preferredSelection(): BrowserTabSelection | undefined {
    return this.fixedTab ? { tab: this.fixedTab, revision: "dashboard" } : this.preferredTab;
  }

  private followPreferredTab(): boolean {
    const revision = this.preferredRevision();
    const preferred = this.preferredSelection;
    if (
      !this.browserPanelIsOpen() ||
      !this.available ||
      !this.client ||
      !preferred ||
      !revision ||
      revision === this.consumedPreferredRevision
    ) {
      return false;
    }
    this.consumedPreferredRevision = revision;
    const tab = readBrowserTabTarget(preferred.tab);
    if (tab) {
      // Session results own the panel route and view, not the user's physical browser focus.
      void this.browserPanelController.selectTab(tab.targetId, tab, { focusBrowserTab: false });
    }
    return true;
  }

  browserPanelIsOpen(): boolean {
    return this.embedded ? this.presented && !this.suppressed : this.dockLayout.open;
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.dockLayout.open) {
      this.closePanel();
    } else {
      this.dockLayout.setOpen(true);
      void this.browserPanelController.refreshAll();
    }
  }

  readonly handleToggleRequest = (event: Event): void => {
    if (this.fixedTab) {
      return;
    }
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as BrowserPanelToggleDetail) // SAFETY: shared panel event payload; consumed fields are validated below.
        : null;
    this.synchronizeBrowserContext();
    const browserTab = readBrowserTabTarget(detail?.browserTab);
    if (detail?.browserTab !== undefined && !browserTab) {
      return;
    }
    const normalizedRequestedUrl =
      typeof detail?.url === "string" ? normalizeBrowserUrlDraft(detail.url) : null;
    let shouldRefresh = true;
    if (this.embedded) {
      if (!this.browserPanelIsOpen() || detail?.open === false || !this.available) {
        return;
      }
    } else {
      if (detail?.dock === "right" || detail?.dock === "bottom") {
        this.dockLayout.setDock(detail.dock, false);
      }
      if (detail?.open === false) {
        this.closePanel();
        return;
      }
      if (!normalizedRequestedUrl && detail?.open !== true) {
        this.toggle();
        return;
      }
      if (!this.available) {
        return;
      }
      shouldRefresh = !this.dockLayout.open;
      this.dockLayout.setOpen(true);
    }
    if (normalizedRequestedUrl) {
      void this.browserPanelController.openUrl(normalizedRequestedUrl, {
        newTab: true,
        native: detail?.native,
      });
    } else if (browserTab) {
      // Consume the current result so it cannot replace this explicit card choice.
      this.consumedPreferredRevision = this.preferredRevision();
      void this.browserPanelController.selectTab(browserTab.targetId, browserTab);
    } else if (detail?.newTab === true) {
      this.browserPanelController.beginNewTab();
    } else if (shouldRefresh && !this.followPreferredTab()) {
      void this.browserPanelController.refreshAll();
    }
  };

  closePanel(): void {
    this.browserPanelController.suspendView();
    this.dockLayout.setOpen(false);
  }
}

export type BrowserPanelInputs = Pick<
  BrowserPanelPresentation,
  | "client"
  | "available"
  | "remoteAvailable"
  | "suppressed"
  | "resourceBasePath"
  | "authToken"
  | "embedded"
  | "tabsInHeader"
  | "presented"
  | "refreshOnPresentation"
  | "sessionKey"
  | "sessionTabs"
  | "preferredTab"
  | "fixedTab"
  | "dashboardTarget"
>;

export type BrowserPanelElement = HTMLElement &
  BrowserPanelInputs &
  Pick<
    BrowserPanelPresentation,
    | "browserPanelIsOpen"
    | "toggle"
    | "handleToggleRequest"
    | "selectHostedTab"
    | "closeHostedTab"
    | "requestUpdate"
    | "renderRoot"
    | "hasUpdated"
    | "hostedTabs"
    | "activeHostedTabId"
    | "browserPanelController"
    | "updateComplete"
  >;
