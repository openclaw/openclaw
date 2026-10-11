import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { terminalFontFamily } from "../../app/terminal-font.ts";
import { t } from "../../i18n/index.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import { terminalPanelLayout, type DockPanelPlacement } from "../dock-panel-layout.ts";
import { icons } from "../icons.ts";
import { notifyPanelHostedTabsChanged } from "../panel-hosted-tabs.ts";
import "../tooltip.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { SolidPanelController } from "../solid-panel-controller.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
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
import { terminalPanelHostedTabs } from "./terminal-panel-tabs.ts";
import { TerminalPanelUploadController } from "./terminal-panel-upload.ts";
import type { TerminalPanelViewState } from "./terminal-panel-view.tsx";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import { renderTerminalSessionPickerTrigger } from "./terminal-session-picker.ts";

type TerminalDock = Exclude<DockPanelPlacement, "left">;

export const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

export class TerminalPanelController extends SolidPanelController {
  context?: ApplicationContext;

  constructor(element: HTMLElement) {
    super(element);
    new SubscriptionsController(this)
      .watchStore(
        () => this.context?.config,
        () => this.terminalPanelUploadController.syncPolicy(),
      )
      .watchStore(() => this.context?.theme);
  }
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

  private sessionPickerOpen = false;
  private pickerSessions: TerminalSessionInfo[] = [];
  private readonly sessionPickerTrigger: { value?: HTMLButtonElement } = {};

  private pickerLoading = false;
  private pickerGeneration = 0;

  private async loadSessionPicker(): Promise<void> {
    const generation = ++this.pickerGeneration;
    const client = this.client;
    if (!client || !this.available) {
      this.pickerLoading = false;
      this.invalidate();
      return;
    }
    this.pickerLoading = true;
    this.invalidate();
    const sessions = await this.terminalSessions.listSessions();
    if (generation !== this.pickerGeneration || client !== this.client || !this.available) {
      return;
    }
    if (sessions !== null) {
      this.pickerSessions = sessions;
    }
    this.pickerLoading = false;
    this.invalidate();
  }
  readonly terminalPanelUploadController = new TerminalPanelUploadController({
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
      this.terminalSessions.tabs.includes(tab as TerminalPanelSessionTab) && tab.status === "live",
    fileInput: () => this.renderRoot.querySelector<HTMLInputElement>(".tp-file-input"),
    setError: (message) => this.terminalSessions.setError(message),
    requestUpdate: () => this.invalidate(),
  });
  get terminalFontFamily(): string {
    return terminalFontFamily(this.context?.theme.settings.terminalFontFamily);
  }

  createTerminalController = createIsolatedGhosttyTerminal;
  catalogReadyTimeoutMs = CATALOG_TERMINAL_READY_TIMEOUT_MS;
  private readonly terminalSessions = new TerminalPanelSessionController(this);
  private readonly dockLayout = new DockLayoutController(this, {
    layout: terminalPanelLayout,
    reservationPrefix: "terminal",
    isAvailable: () => this.isDockLayoutAvailable(),
    isFullscreen: () => this.fullscreen,
    onResize: () =>
      this.terminalSessions.tabs
        .find((tab) => tab.id === this.terminalSessions.activeId)
        ?.controller.fit(),
  });
  private themeObserver: MutationObserver | null = null;

  private get sessionBottomOnly(): boolean {
    return !this.embedded && this.sessionKey !== null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.terminalSessions.connectHost();
    // A settings takeover can already own the viewport when the panel mounts.
    // Suppress before the restored open state boots a session nobody can see.
    this.dockLayout.setSuppressed(this.suppressed);
    if (!this.fullscreen && !this.embedded && !this.sessionBottomOnly) {
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
    }
    if (!this.fullscreen && !this.embedded) {
      window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.handleToggleRequest);
    }
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() =>
        updateTerminalSessionTheme(this.terminalSessions.tabs, this.themeMode),
      );
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode", "style"],
      });
    }
    if (this.dockLayout.open) {
      void this.terminalSessions.restoreSessions();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
    window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.handleToggleRequest);
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.terminalSessions.disconnectHost();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if ((changed.has("embedded") || changed.has("sessionKey")) && !this.fullscreen) {
      if (this.embedded || this.sessionBottomOnly) {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      } else {
        window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      }
      if (this.embedded) {
        window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.handleToggleRequest);
      } else {
        window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, this.handleToggleRequest);
      }
    }
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
      this.sessionPickerOpen,
      this.pickerLoading,
      this.pickerSessions.map((session) => session.sessionId),
      this.terminalPanelUploadController.uploadsEnabled(),
      this.terminalPanelUploadController.hasPendingBatch(),
      this.terminalPanelUploadController.hasActiveTab(),
    ]);
  }

  get hostedTabs() {
    return terminalPanelHostedTabs(this.terminalSessions.tabs);
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

  get hostedActions() {
    if (!this.embedded || !this.tabsInHeader) {
      return nothing;
    }
    const upload = this.terminalPanelUploadController;
    return html`
      <openclaw-tooltip .content=${t("terminal.sessions")}>
        ${renderTerminalSessionPickerTrigger(this.sessionPickerProps)}
      </openclaw-tooltip>
      ${
        upload.uploadsEnabled()
          ? html`<openclaw-tooltip .content=${t("terminal.addFiles")}>
              <button
                class="rail-header__action"
                type="button"
                aria-label=${t("terminal.addFiles")}
                ?disabled=${!upload.hasActiveTab() || upload.hasPendingBatch()}
                @click=${upload.chooseFiles}
              >
                ${icons.paperclip}
              </button>
            </openclaw-tooltip>`
          : nothing
      }
      <openclaw-tooltip .content=${t("terminal.dockBottom")}>
        <button
          class="rail-header__action"
          type="button"
          aria-label=${t("terminal.dockBottom")}
          ?disabled=${!this.terminalSessions.canHandoffSessions}
          @click=${() => this.setDock("bottom")}
        >
          ${icons.panelBottomOpen}
        </button>
      </openclaw-tooltip>
    `;
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
    this.closeSessionPicker(false);
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

  private toggleSessionPicker(): void {
    if (this.sessionPickerOpen) {
      this.closeSessionPicker(true);
      return;
    }
    this.sessionPickerOpen = true;
    this.invalidate();
    void this.loadSessionPicker();
    void this.updateComplete.then(() => {
      if (this.sessionPickerOpen) {
        this.renderRoot.querySelector<HTMLButtonElement>(".tp-session-refresh")?.focus();
      }
    });
  }

  private closeSessionPicker(restoreFocus: boolean): void {
    if (!this.sessionPickerOpen) {
      return;
    }
    this.sessionPickerOpen = false;
    this.invalidate();
    if (restoreFocus) {
      void this.updateComplete.then(() => {
        this.sessionPickerTrigger.value?.focus();
      });
    }
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.sessionPickerOpen) {
      return;
    }
    const menu = this.renderRoot.querySelector(".tp-session-menu");
    // The hosted trigger lives in the side-panel header; the menu stays in this panel.
    const path = event.composedPath();
    const trigger = this.sessionPickerTrigger.value;
    if (!(trigger && path.includes(trigger)) && !(menu && path.includes(menu))) {
      this.closeSessionPicker(false);
    }
  };

  private handleSessionPickerFocusOut(event: FocusEvent): void {
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      (target === this.sessionPickerTrigger.value ||
        this.renderRoot.querySelector(".tp-session-menu")?.contains(target));
    if (isInside(event.relatedTarget)) {
      return;
    }
    queueMicrotask(() => {
      if (!isInside(document.activeElement) && this.sessionPickerOpen) {
        this.closeSessionPicker(false);
      }
    });
  }

  private async attachPickedSession(
    sessionId: string,
    owner?: TerminalSessionInfo["owner"],
  ): Promise<void> {
    this.sessionPickerOpen = false;
    this.invalidate();
    await this.terminalSessions.attachSessionById(sessionId, owner?.startsWith("agent:") === true);
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
    this.closeSessionPicker(false);
    this.pickerGeneration += 1;
    this.pickerLoading = false;
    this.pickerSessions = [];
  }

  findTerminalPanelViewport(): Element | null {
    return this.renderRoot.querySelector(".tp-viewport");
  }

  private get sessionPickerProps() {
    return {
      hosted: this.embedded && this.tabsInHeader,
      triggerRef: this.sessionPickerTrigger,
      open: this.sessionPickerOpen,
      loading: this.pickerLoading,
      sessions: this.pickerSessions,
      currentSessionIds: new Set(
        this.terminalSessions.tabs
          .map((tab) => tab.gatewaySessionId)
          .filter((sessionId) => sessionId.length > 0),
      ),
      onToggle: () => this.toggleSessionPicker(),
      onDismiss: (restoreFocus: boolean) => this.closeSessionPicker(restoreFocus),
      onFocusOut: (event: FocusEvent) => this.handleSessionPickerFocusOut(event),
      onRefresh: () => void this.loadSessionPicker(),
      onAttach: (sessionId: string, owner: TerminalSessionInfo["owner"]) =>
        void this.attachPickedSession(sessionId, owner),
    };
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
      picker: {
        ...this.sessionPickerProps,
        triggerRef: (element) => {
          this.sessionPickerTrigger.value = element;
        },
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

/** Public custom-element surface retained for the shell and panel hosts. */
export type OpenClawTerminalPanel = HTMLElement &
  Pick<
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
    | "requestUpdate"
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
