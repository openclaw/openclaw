import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { terminalFontFamily } from "../../app/terminal-font.ts";
import { renderSolidSnapshot } from "../../lib/dom/solid-snapshot.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createDockLayout } from "../dock-layout.ts";
import { terminalPanelLayout, type DockPanelPlacement } from "../dock-panel-layout.ts";
import { notifyPanelHostedTabsChanged } from "../panel-hosted-tabs.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { SolidPanelOwner } from "../solid-panel-owner.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { updateTerminalFont } from "./terminal-fonts.ts";
import { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import {
  reattachTerminalSessionHosts,
  updateTerminalSessionTheme,
} from "./terminal-panel-session-rendering.ts";
import type {
  TerminalPanelSessionTab,
  TerminalRouteTarget,
} from "./terminal-panel-session-types.ts";
import { terminalPanelTabIcon, terminalPanelHostedTabs } from "./terminal-panel-tabs.ts";
import { createTerminalPanelUpload, type TerminalPanelUpload } from "./terminal-panel-upload.ts";
import type { TerminalPanelViewState } from "./terminal-panel-view.tsx";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import { createTerminalSessionPicker } from "./terminal-session-picker.ts";

// Clone the SVG itself: insertion consumes a fragment and loses its replacement boundary.
const hostedTabIcon = renderSolidSnapshot(terminalPanelTabIcon).firstElementChild!;

type TerminalDock = Exclude<DockPanelPlacement, "left">;

export const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

export class TerminalPanelController extends SolidPanelOwner {
  context?: ApplicationContext;

  /** Gateway client used for terminal.* RPCs; null until connected. */
  client: TerminalGatewayClient | null = null;
  /** Agent whose workspace and sandbox policy own newly opened sessions. */
  agentId: string | null = null;
  /** Conversation that owns newly opened session-scoped terminals. */
  sessionKey: string | null = null;
  /** Whether the connected gateway advertises the terminal surface. */
  available = false;
  /** Full-page route takeovers (settings) own the viewport; the dock hides while one renders. */
  suppressed = false;
  themeMode: "dark" | "light" = "dark";
  basePath = "";
  /**
   * Focused terminal document mode (`/focus/terminal`): fills the
   * viewport, stays open while available, and omits dock chrome.
   */
  fullscreen = false;
  /** Hosted by the chat side panel, which owns visibility and geometry. */
  embedded = false;
  /** The embedding pane owns removal of its terminal slot. */
  onClose?: () => void;
  /** The hosting side-panel header presents this panel's tabs and actions. */
  tabsInHeader = false;
  /** Main-route terminal owns its queue and restore state independently of docks. */
  page = false;
  routeTarget: TerminalRouteTarget = null;

  private sessionPicker!: ReturnType<typeof createTerminalSessionPicker>;
  terminalPanelUploadController!: TerminalPanelUpload;
  private fileInput: HTMLInputElement | null = null;

  bindPresentation(): void {
    this.terminalPanelUploadController = createTerminalPanelUpload({
      activeTab: () =>
        this.terminalSessions.tabs.find(
          (tab) =>
            tab.id === this.terminalSessions.activeId &&
            tab.status === "live" &&
            tab.gatewaySessionId,
        ),
      client: () => this.client,
      config: () => this.context?.config,
      isCurrent: (tab) =>
        this.terminalSessions.tabs.includes(tab as TerminalPanelSessionTab) &&
        tab.status === "live",
      fileInput: () => this.fileInput,
      setError: (message) => this.terminalSessions.setError(message),
    });
    this.sessionPicker = createTerminalSessionPicker({
      client: () => this.client,
      available: () => this.available,
      hosted: () => this.embedded && this.tabsInHeader,
      currentSessionIds: () =>
        new Set(this.terminalSessions.tabs.map((tab) => tab.gatewaySessionId).filter(Boolean)),
      list: () => this.terminalSessions.listSessions(),
      attach: (id, agentOwned) => this.terminalSessions.attachSessionById(id, agentOwned),
    });
    onSettled(() => {
      const stopConfig = this.context?.config?.subscribe(() => {
        this.terminalPanelUploadController.syncPolicy();
        this.invalidate();
      });
      const stopTheme = this.context?.theme?.subscribe(() => this.invalidate());
      this.terminalPanelUploadController.syncPolicy();
      const stopToggle = listen(window, TERMINAL_PANEL_TOGGLE_EVENT, (event) => {
        if (!this.fullscreen && !this.embedded && !this.sessionBottomOnly) {
          this.handleToggleRequest(event);
        }
      });
      const stopBottom = listen(window, TERMINAL_PANEL_DOCK_BOTTOM_EVENT, (event) => {
        if (!this.fullscreen && !this.embedded) {
          this.handleToggleRequest(event);
        }
      });
      const observer = new MutationObserver(() =>
        updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode),
      );
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode", "style"],
      });
      return () => {
        stopConfig?.();
        stopTheme?.();
        stopToggle();
        stopBottom();
        observer.disconnect();
      };
    });
  }
  get terminalFontFamily(): string {
    return terminalFontFamily(this.context?.theme.settings.terminalFontFamily);
  }

  createTerminalController = createIsolatedGhosttyTerminal;
  catalogReadyTimeoutMs = CATALOG_TERMINAL_READY_TIMEOUT_MS;
  private readonly terminalSessions = new TerminalPanelSessionController(this);
  private readonly dockLayout = createDockLayout({
    notify: () => this.invalidate(),
    isEmbedded: () => this.embedded,
    layout: terminalPanelLayout,
    reservationPrefix: "terminal",
    isAvailable: () => this.isDockLayoutAvailable(),
    isFullscreen: () => this.fullscreen,
    onResize: () =>
      this.terminalSessions.tabs
        .find((tab) => tab.id === this.terminalSessions.activeId)
        ?.controller.fit(),
  });

  private get sessionBottomOnly(): boolean {
    return !this.embedded && this.sessionKey !== null;
  }

  override connectedCallback(): void {
    this.dockLayout.connect();
    this.terminalSessions.connectHost();
    // A settings takeover can already own the viewport when the panel mounts.
    // Suppress before the restored open state boots a session nobody can see.
    this.dockLayout.setSuppressed(this.suppressed);
    if (this.dockLayout.open) {
      void this.terminalSessions.restoreSessions();
    }
  }

  override disconnectedCallback(): void {
    this.terminalSessions.disconnectHost();
    this.dockLayout.dispose();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("suppressed") && this.dockLayout.setSuppressed(this.suppressed)) {
      // Restoring after a takeover: a reconnect during settings disposed the tabs
      // without restoring them, so re-run the normal open path.
      void this.terminalSessions.restoreSessions();
    }
    if (changed.has("client") || changed.has("available")) {
      this.terminalSessions.scheduleLifecycleSync();
    }
    for (const tab of this.terminalSessions.tabs) {
      updateTerminalFont(tab.controller, this.terminalFontFamily);
    }
    if (changed.has("themeMode")) {
      updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode);
    }
    if (changed.has("embedded") && this.embedded) {
      void this.terminalSessions.restoreSessions();
    }
    if (this.embedded || this.dockLayout.open) {
      reattachTerminalSessionHosts(
        this.terminalSessions.tabs,
        this.terminalSessions.activeId,
        this.findTerminalPanelViewport(),
      );
    }
    this.dockLayout.syncReservation();
    notifyPanelHostedTabsChanged(this.element, [
      this.embedded && this.tabsInHeader,
      this.terminalSessions.activeId,
      this.hostedTabs.map(({ id, label, statusLabel, badge, className }) => [
        id,
        label,
        statusLabel,
        badge,
        className,
      ]),
      this.terminalSessions.booting,
      this.terminalSessions.canHandoffSessions,
    ]);
  }

  get hostedTabs() {
    return terminalPanelHostedTabs(this.terminalSessions.tabs).map((tab) =>
      Object.assign(tab, { icon: hostedTabIcon.cloneNode(true) }),
    );
  }

  get activeHostedTabId(): string | null {
    return this.terminalSessions.activeId;
  }

  selectHostedTab(id: string): void {
    this.terminalSessions.switchTo(id);
  }

  async closeHostedTab(id: string): Promise<void> {
    this.terminalSessions.closeTab(id);
    await this.updateComplete;
  }

  hostedActionsContent: HTMLElement | undefined;

  get hostedActions(): HTMLElement | undefined {
    return this.embedded && this.tabsInHeader ? this.hostedActionsContent : undefined;
  }

  activateTerminalHost(): void {
    this.terminalSessions.activateHost();
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.dockLayout.open) {
      this.closeTerminalPanel();
    } else {
      this.dockLayout.setOpen(true);
      this.activateTerminalHost();
      void this.terminalSessions.restoreSessions();
    }
  }

  readonly handleToggleRequest = (event: Event): void => {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as TerminalPanelToggleDetail)
        : null;
    const dock = detail?.dock === "right" || detail?.dock === "bottom" ? detail.dock : null;
    if (detail?.agentId !== undefined) {
      this.agentId = detail.agentId;
    }
    if (dock) {
      this.dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      this.closeTerminalPanel();
      return;
    }
    if (detail?.terminalSessionId || detail?.open === true || detail?.newSession === true) {
      if (!this.available) {
        return;
      }
      this.dockLayout.setOpen(true);
      this.activateTerminalHost();
      void (detail.newSession === true
        ? this.terminalSessions.openSession()
        : detail.terminalSessionId
          ? this.terminalSessions.attachSessionById(detail.terminalSessionId, true)
          : this.terminalSessions.restoreSessions());
      return;
    }
    this.toggle();
  };

  closeTerminalPanel(): void {
    this.sessionPicker?.onDismiss(false);
    this.terminalSessions.cancelPendingActions();
    if (this.embedded) {
      this.onClose?.();
    } else {
      this.dockLayout.setOpen(false);
    }
  }

  get terminalPanelOpen(): boolean {
    return this.embedded ? this.available : this.dockLayout.open && this.isDockLayoutAvailable();
  }

  hideTerminalPanelForUnavailableSurface(): void {
    // The surface disappeared (gateway disconnect/disable). Hide the panel
    // WITHOUT persisting: a disconnect must not overwrite the user's open
    // preference, or the reconnect path would never auto-reopen. Server
    // sessions survive for the detach grace period and reattach afterwards.
    this.dockLayout.hideWithoutPersisting();
  }

  restoreTerminalPanelOpenState(): boolean {
    return this.dockLayout.restoreOpenState();
  }

  private isDockLayoutAvailable(): boolean {
    return this.available && (!this.sessionBottomOnly || this.dockLayout.dock === "bottom");
  }

  private setDock(dock: TerminalDock): void {
    // Moving between the global bottom dock and a chat's side panel changes
    // presentation owners, not just geometry. The active pane owns the return.
    const returnToSession = this.sessionBottomOnly && dock === "right";
    if ((this.embedded && dock === "bottom") || returnToSession) {
      if (!this.terminalSessions.handoffSessions()) {
        return;
      }
      if (returnToSession) {
        this.dockLayout.setOpen(false);
      }
      window.dispatchEvent(
        new CustomEvent<TerminalPanelToggleDetail>(
          returnToSession ? TERMINAL_PANEL_TOGGLE_EVENT : TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
          { detail: { agentId: this.agentId, dock, open: true } },
        ),
      );
      return;
    }
    this.dockLayout.setDock(dock);
    void this.updateComplete.then(() => {
      for (const tab of this.terminalSessions.tabs) {
        tab.controller.fit();
      }
    });
  }

  private openFullscreen(): void {
    const focusPath = buildControlUiFocusPath({ kind: "terminal" }, this.basePath);
    if (focusPath) {
      openExternalUrlSafe(focusPath);
    }
  }

  resetTerminalSessionPicker(): void {
    this.sessionPicker?.reset();
  }

  findTerminalPanelViewport(): Element | null {
    return this.renderRoot.querySelector(".tp-viewport");
  }

  get viewState(): TerminalPanelViewState {
    const activeTab = this.terminalSessions.tabs.find(
      (tab) => tab.id === this.terminalSessions.activeId,
    );
    return {
      open: this.terminalPanelOpen,
      embedded: this.embedded,
      fullscreen: this.fullscreen,
      hosted: this.embedded && this.tabsInHeader,
      mode: this.embedded ? "embedded" : this.fullscreen ? "fullscreen" : this.dockLayout.dock,
      style:
        this.embedded || this.fullscreen || this.dockLayout.dock === "main"
          ? undefined
          : this.dockLayout.dock === "bottom"
            ? `height:${this.dockLayout.height}px;--tp-panel-height:${this.dockLayout.height}px`
            : `width:${this.dockLayout.width}px`,
      dockLayout: this.dockLayout,
      tabs: this.terminalSessions.tabs,
      activeId: this.terminalSessions.activeId,
      booting: this.terminalSessions.booting,
      connecting:
        this.terminalSessions.waitingForRefresh ||
        (this.terminalSessions.booting && this.terminalSessions.tabs.length === 0) ||
        activeTab?.status === "connecting",
      error: this.terminalSessions.error
        ? {
            text: this.terminalSessions.error.text,
            retry: this.terminalSessions.error.retryAction
              ? () => this.terminalSessions.retryOpen()
              : undefined,
          }
        : null,
      dockDisabled:
        (this.embedded || this.sessionBottomOnly) && !this.terminalSessions.canHandoffSessions,
      picker: this.sessionPicker,
      fileInputRef: (element) => {
        this.fileInput = element;
      },
      upload: this.terminalPanelUploadController,
      onSelect: (id) => this.terminalSessions.switchTo(id),
      onClose: (id) => this.closeHostedTab(id),
      onNew: () => void this.terminalSessions.openSession(),
      onDock: (dock) => this.setDock(dock),
      onOpenFullscreen: () => this.openFullscreen(),
      onHide: () => this.closeTerminalPanel(),
    };
  }

  override willUpdate(): void {
    // Ghostty measures its canvas; only the active session may occupy the viewport.
    for (const tab of this.terminalSessions.tabs) {
      tab.host.style.display = tab.id === this.terminalSessions.activeId ? "block" : "none";
    }
  }
}

export type TerminalInputs = Pick<
  TerminalPanelController,
  | "client"
  | "agentId"
  | "sessionKey"
  | "available"
  | "suppressed"
  | "themeMode"
  | "basePath"
  | "fullscreen"
  | "embedded"
  | "onClose"
  | "tabsInHeader"
  | "page"
  | "routeTarget"
  | "createTerminalController"
  | "catalogReadyTimeoutMs"
>;

/** Public custom-element surface retained for the shell and panel hosts. */
export type OpenClawTerminalPanel = HTMLElement &
  Pick<
    TerminalPanelController,
    | keyof TerminalInputs
    | "activateTerminalHost"
    | "toggle"
    | "closeTerminalPanel"
    | "hideTerminalPanelForUnavailableSurface"
    | "restoreTerminalPanelOpenState"
    | "resetTerminalSessionPicker"
    | "findTerminalPanelViewport"
    | "selectHostedTab"
    | "closeHostedTab"
    | "handleToggleRequest"
    | "invalidate"
    | "renderRoot"
    | "hasUpdated"
    | "hostedTabs"
    | "activeHostedTabId"
    | "hostedActions"
    | "terminalPanelOpen"
    | "terminalPanelUploadController"
    | "updateComplete"
  >;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
