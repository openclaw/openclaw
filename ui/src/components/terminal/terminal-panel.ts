import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import type { ApplicationContext } from "../../app/context.ts";
import { terminalFontFamily } from "../../app/terminal-font.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { renderSolidSnapshot } from "../../lib/dom/solid-snapshot.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createDockLayout } from "../dock-layout.ts";
import { terminalPanelLayout, type DockPanelPlacement } from "../dock-panel-layout.ts";
import { notifyPanelHostedTabsChanged } from "../panel-hosted-tabs.ts";
import { createPanelPresentationLifecycle } from "../panel-presentation-lifecycle.ts";
import {
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type TerminalPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import { updateTerminalFont } from "./terminal-fonts.ts";
import { createTerminalPanelSessions } from "./terminal-panel-session-controller.ts";
import {
  reattachTerminalSessionHosts,
  updateTerminalSessionTheme,
} from "./terminal-panel-session-rendering.ts";
import type { TerminalInputs } from "./terminal-panel-session-types.ts";
import { terminalPanelTabIcon, terminalPanelHostedTabs } from "./terminal-panel-tabs.tsx";
import { createTerminalPanelUpload, type TerminalPanelUpload } from "./terminal-panel-upload.ts";
import { createTerminalSessionPicker } from "./terminal-session-picker.ts";

// Clone the SVG itself: insertion consumes a fragment and loses its replacement boundary.
const hostedTabIcon = renderSolidSnapshot(terminalPanelTabIcon).firstElementChild!;

type TerminalDock = Exclude<DockPanelPlacement, "left">;

export const CATALOG_TERMINAL_READY_TIMEOUT_MS = 30_000;

export type TerminalPanelOwner = ReturnType<typeof createTerminalPanel>;
export type TerminalPanelMethods = Pick<
  TerminalPanelOwner,
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
>;
export type OpenClawTerminalPanel = HTMLElement &
  TerminalInputs &
  TerminalPanelMethods &
  Pick<
    TerminalPanelOwner,
    "hostedTabs" | "activeHostedTabId" | "hostedActions" | "terminalPanelOpen" | "updateComplete"
  >;

/** Owns synchronous PTY/dock authority; Solid reads its publication projection. */
export function createTerminalPanel(
  element: HTMLElement & TerminalInputs,
  scheduleAfterRender: (callback: () => void) => void,
) {
  let context: ApplicationContext | undefined;
  let changes = new Set<keyof TerminalInputs>();
  let fileInput: HTMLInputElement | undefined;
  let viewport: HTMLDivElement | undefined;
  let sessionPicker: ReturnType<typeof createTerminalSessionPicker> | undefined;
  let terminalPanelUploadController: TerminalPanelUpload;
  const lifecycle = createPanelPresentationLifecycle(scheduleAfterRender, () => {
    const changed = changes;
    changes = new Set();
    // Ghostty measures its canvas; only the active session may occupy the viewport.
    for (const tab of terminalSessions.state.tabs) {
      tab.host.style.display = tab.id === terminalSessions.state.activeId ? "block" : "none";
    }
    updated(changed);
  });
  const publish = lifecycle.publish;
  let hostedActionsContent: HTMLElement | undefined;
  const handleToggleRequest = (event: Event): void => {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as TerminalPanelToggleDetail) // SAFETY: shared panel event; consumed fields are validated below.
        : null;
    const dock = detail?.dock === "right" || detail?.dock === "bottom" ? detail.dock : null;
    if (detail?.agentId !== undefined) {
      element.agentId = detail.agentId;
    }
    if (dock) {
      dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      owner.closeTerminalPanel();
      return;
    }
    if (detail?.terminalSessionId || detail?.open === true || detail?.newSession === true) {
      if (!element.available) {
        return;
      }
      dockLayout.setOpen(true);
      owner.activateTerminalHost();
      void (detail.newSession === true
        ? terminalSessions.openSession()
        : detail.terminalSessionId
          ? terminalSessions.attachSessionById(detail.terminalSessionId, true)
          : terminalSessions.restoreSessions());
      return;
    }
    owner.toggle();
  };

  function readSessionBottomOnly(): boolean {
    return !element.embedded && element.sessionKey !== null;
  }

  function updated(changed: ReadonlySet<keyof TerminalInputs>): void {
    if (changed.has("suppressed") && dockLayout.setSuppressed(element.suppressed)) {
      // Restoring after a takeover: a reconnect during settings disposed the tabs
      // without restoring them, so re-run the normal open path.
      void terminalSessions.restoreSessions();
    }
    terminalSessions.scheduleLifecycleSync();
    if (changed.has("gatewayConnected") && element.gatewayConnected && sessionPicker?.open()) {
      sessionPicker.onRefresh();
    }
    for (const tab of terminalSessions.state.tabs) {
      updateTerminalFont(tab.controller, owner.terminalFontFamily);
    }
    if (changed.has("themeMode")) {
      updateTerminalSessionTheme(terminalSessions.state.tabs, element.themeMode);
    }
    if (changed.has("embedded") && element.embedded) {
      void terminalSessions.restoreSessions();
    }
    if (element.embedded || dockLayout.open) {
      reattachTerminalSessionHosts(
        terminalSessions.state.tabs,
        terminalSessions.state.activeId,
        owner.findTerminalPanelViewport(),
      );
    }
    dockLayout.syncReservation();
    notifyPanelHostedTabsChanged(element, [
      element.embedded && element.tabsInHeader,
      terminalSessions.state.activeId,
      owner.hostedTabs.map(({ id, label, statusLabel, badge, className, closeDisabled }) => [
        id,
        label,
        statusLabel,
        badge,
        className,
        closeDisabled,
      ]),
      terminalSessions.state.booting,
      terminalSessions.canHandoffSessions,
    ]);
  }

  function isDockLayoutAvailable(): boolean {
    return element.available && (!readSessionBottomOnly() || dockLayout.dock === "bottom");
  }

  function setDock(dock: TerminalDock): void {
    // Moving between the global bottom dock and a chat's side panel changes
    // presentation owners, not just geometry. The active pane owns the return.
    const returnToSession = readSessionBottomOnly() && dock === "right";
    if ((element.embedded && dock === "bottom") || returnToSession) {
      if (!terminalSessions.handoffSessions()) {
        return;
      }
      if (returnToSession) {
        dockLayout.setOpen(false);
      }
      window.dispatchEvent(
        new CustomEvent<TerminalPanelToggleDetail>(
          returnToSession ? TERMINAL_PANEL_TOGGLE_EVENT : TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
          { detail: { agentId: element.agentId, dock, open: true } },
        ),
      );
      return;
    }
    dockLayout.setDock(dock);
    void lifecycle.updateComplete.then(() => {
      for (const tab of terminalSessions.state.tabs) {
        tab.controller.fit();
      }
    });
  }

  function openFullscreen(): void {
    const focusPath = buildControlUiFocusPath({ kind: "terminal" }, element.basePath);
    if (focusPath) {
      openExternalUrlSafe(focusPath);
    }
  }

  function bindPresentation() {
    terminalPanelUploadController = createTerminalPanelUpload({
      activeTab: () =>
        terminalSessions.state.tabs.find(
          (tab) =>
            tab.id === terminalSessions.state.activeId &&
            tab.status === "live" &&
            tab.gatewaySessionId,
        ),
      client: () => (element.gatewayConnected && element.available ? element.client : null),
      config: () => context?.config,
      isCurrent: (tab) =>
        terminalSessions.state.tabs.some((entry) => entry === tab) && tab.status === "live",
      fileInput: () => (fileInput && element.contains(fileInput) ? fileInput : null),
      setError: (message) => terminalSessions.setError(message),
    });
    sessionPicker = createTerminalSessionPicker({
      client: () => (element.gatewayConnected && element.available ? element.client : null),
      available: () => element.available,
      hosted: () => element.embedded && element.tabsInHeader,
      connected: () => element.gatewayConnected,
      currentSessionIds: () =>
        new Set(terminalSessions.state.tabs.map((tab) => tab.gatewaySessionId).filter(Boolean)),
      list: () => terminalSessions.listSessions(),
      showError: (error) => terminalSessions.setError(formatUiError(error)),
      attach: (id, agentOwned) => terminalSessions.attachSessionById(id, agentOwned),
    });
  }
  const dockLayout = createDockLayout({
    notify: publish,
    layout: terminalPanelLayout,
    reservationPrefix: "terminal",
    isAvailable: isDockLayoutAvailable,
    isFullscreen: () => element.fullscreen,
    isEmbedded: () => element.embedded,
    onResize: () =>
      terminalSessions.state.tabs
        .find((tab) => tab.id === terminalSessions.state.activeId)
        ?.controller.fit(),
  });

  const owner = {
    inputs: element,
    get isConnected() {
      return lifecycle.active() && element.isConnected;
    },
    get updateComplete() {
      return lifecycle.updateComplete;
    },
    publish,
    bindPresentation,
    subscribe: lifecycle.subscribe,
    inputsChanged(name: keyof TerminalInputs) {
      changes.add(name);
      publish();
    },
    attach(application: ApplicationContext | undefined) {
      context = application;
      lifecycle.connect();
      terminalPanelUploadController.syncPolicy();
      dockLayout.connect();
      terminalSessions.connectHost();
      dockLayout.setSuppressed(element.suppressed);
      const observer = new MutationObserver(() =>
        updateTerminalSessionTheme(terminalSessions.state.tabs, element.themeMode),
      );
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-mode", "style"],
      });
      const stops = [
        listen(window, TERMINAL_PANEL_TOGGLE_EVENT, (event) => {
          if (!element.fullscreen && !element.embedded && !readSessionBottomOnly()) {
            handleToggleRequest(event);
          }
        }),
        listen(window, TERMINAL_PANEL_DOCK_BOTTOM_EVENT, (event) => {
          if (!element.fullscreen && !element.embedded) {
            handleToggleRequest(event);
          }
        }),
        // Hosted tab labels are published to the external header after the panel commits.
        i18n.subscribe(publish),
        // Configuration receipts retire disallowed uploads before their next operation.
        context?.config.subscribe(() => {
          terminalPanelUploadController.syncPolicy();
          publish();
        }),
        // The commit applies font changes to imperative Ghostty controllers.
        context?.theme.subscribe(publish),
      ];
      if (element.embedded || dockLayout.open) {
        void terminalSessions.restoreSessions();
      }
      publish();
      return () =>
        lifecycle.dispose(() => {
          observer.disconnect();
          stops.forEach((stop) => stop?.());
          terminalSessions.disconnectHost();
          dockLayout.dispose();
        });
    },
    get terminalPanelUploadController() {
      return terminalPanelUploadController;
    },
    get terminalFontFamily() {
      return terminalFontFamily(context?.theme.settings.terminalFontFamily);
    },
    get hostedTabs() {
      return terminalPanelHostedTabs(terminalSessions.state.tabs, element.gatewayConnected).map(
        (tab) => Object.assign(tab, { icon: hostedTabIcon.cloneNode(true) }),
      );
    },
    get activeHostedTabId() {
      return terminalSessions.state.activeId;
    },
    selectHostedTab(id: string): void {
      terminalSessions.switchTo(id);
    },
    async closeHostedTab(id: string): Promise<void> {
      terminalSessions.closeTab(id);
      await lifecycle.updateComplete;
    },
    set hostedActionsContent(value: HTMLElement | undefined) {
      hostedActionsContent = value;
    },
    get hostedActions() {
      return element.embedded && element.tabsInHeader ? hostedActionsContent : undefined;
    },
    activateTerminalHost(): void {
      terminalSessions.activateHost();
      // Another dock may have settled the shared queue while this view was inactive.
      publish();
    },
    toggle(): void {
      if (!element.available) {
        return;
      }
      if (dockLayout.open) {
        owner.closeTerminalPanel();
      } else {
        dockLayout.setOpen(true);
        owner.activateTerminalHost();
        void terminalSessions.restoreSessions();
      }
    },
    handleToggleRequest,
    closeTerminalPanel(): void {
      sessionPicker?.onDismiss(false);
      terminalSessions.cancelPendingActions();
      if (element.embedded) {
        element.onClose?.();
      } else {
        dockLayout.setOpen(false);
      }
    },
    get terminalPanelOpen(): boolean {
      return element.embedded ? element.available : dockLayout.open && isDockLayoutAvailable();
    },
    hideTerminalPanelForUnavailableSurface(): void {
      // The surface disappeared (gateway disconnect/disable). Hide the panel
      // WITHOUT persisting: a disconnect must not overwrite the user's open
      // preference, or the reconnect path would never auto-reopen. Server
      // sessions survive for the detach grace period and reattach afterwards.
      dockLayout.hideWithoutPersisting();
    },
    restoreTerminalPanelOpenState(): boolean {
      return dockLayout.restoreOpenState();
    },
    resetTerminalSessionPicker(): void {
      sessionPicker?.reset();
    },
    findTerminalPanelViewport(): Element | null {
      return viewport && element.contains(viewport) ? viewport : null;
    },
    get viewState() {
      const activeTab = terminalSessions.state.tabs.find(
        (tab) => tab.id === terminalSessions.state.activeId,
      );
      return {
        open: owner.terminalPanelOpen,
        embedded: element.embedded,
        fullscreen: element.fullscreen,
        hosted: element.embedded && element.tabsInHeader,
        mode: element.embedded ? "embedded" : element.fullscreen ? "fullscreen" : dockLayout.dock,
        style:
          element.embedded || element.fullscreen || dockLayout.dock === "main"
            ? undefined
            : dockLayout.dock === "bottom"
              ? `height:${dockLayout.height}px;--tp-panel-height:${dockLayout.height}px`
              : `width:${dockLayout.width}px`,
        dockLayout,
        tabs: terminalSessions.state.tabs,
        activeId: terminalSessions.state.activeId,
        booting: terminalSessions.state.booting,
        connected: element.gatewayConnected,
        connecting:
          terminalSessions.waitingForRefresh ||
          (terminalSessions.state.booting && terminalSessions.state.tabs.length === 0) ||
          activeTab?.status === "connecting",
        error: terminalSessions.state.error
          ? {
              text: terminalSessions.state.error.text,
              retry: terminalSessions.state.error.retryAction
                ? () => terminalSessions.retryOpen()
                : undefined,
            }
          : null,
        dockDisabled:
          (element.embedded || readSessionBottomOnly()) && !terminalSessions.canHandoffSessions,
        upload: terminalPanelUploadController,
        picker: sessionPicker!,
        fileInputRef: (input: HTMLInputElement) => {
          fileInput = input;
        },
        viewportRef: (nextViewport: HTMLDivElement) => {
          viewport = nextViewport;
        },
        onSelect: (id: string) => terminalSessions.switchTo(id),
        onClose: (id: string): Promise<void> => owner.closeHostedTab(id),
        onNew: () => void terminalSessions.openSession(),
        onDock: (dock: TerminalDock) => setDock(dock),
        onOpenFullscreen: () => openFullscreen(),
        onHide: (): void => owner.closeTerminalPanel(),
      };
    },
  };
  const terminalSessions = createTerminalPanelSessions(owner);
  return owner;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
