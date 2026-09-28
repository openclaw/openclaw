import { isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId, routeIdFromPath } from "../app-route-paths.ts";
import {
  applyCommandPaletteTargetEvent,
  COMMAND_PALETTE_OPEN_EVENT,
  COMMAND_PALETTE_TARGET_EVENT,
  isCommandPaletteShortcut,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  shellNavDrawerTriggerFromEvent,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  isHomePanelShortcut,
  isTerminalPanelShortcut,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { focusWithoutTooltip } from "../components/tooltip.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutsDialogElement,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import {
  readDebugOverlayMode,
  shouldCloseDebugOverlay,
  type DebugOverlayElement,
  type DebugOverlayMode,
} from "../pages/debug/debug-overlay-frame.ts";
import { ShellCommandPaletteOwner } from "./app-shell-command-palette-loading.ts";
import { openShellNewSession, type ShellNewSessionHost } from "./app-shell-new-session.ts";
import { ShellPanelOwner, type ShellPanelHost } from "./app-shell-panels.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import {
  isOptionalElementDefined,
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import {
  clearLazyShellAction,
  lazyShellEvent,
  persistLazyShellAction,
  readLazyShellAction,
  SHELL_APPROVALS_OPEN_EVENT,
  type LazyShellEvent,
} from "./lazy-shell-action.ts";
import { isMobileNavLayout } from "./mobile-nav-layout.ts";
import {
  NATIVE_HISTORY_STATE_EVENT,
  readNativeHistoryState,
  type NativeHistoryState,
} from "./native-web-chrome.ts";
import { NavDrawerSwipeLoader } from "./nav-drawer-swipe-loader.ts";
import {
  dismissNavigationTransientSurfaces,
  handleNavDrawerKeydown,
  moveToastToNavDrawer,
  restoreToastFromNavDrawer,
  visibleNavDrawerToggle,
} from "./navigation-surface.ts";
import { isHomePanelAvailable } from "./panel-availability.ts";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";
import { connectShellViewport } from "./shell-viewport.ts";
import { retryStaleChunkReloadWhenReachable } from "./stale-chunk-reload.ts";

let nativeCommandsOwner: AbortController | undefined;

export interface ShellChromeHost extends ShellNewSessionHost, ShellPanelHost {
  readonly activeSessionKey: string;
  readonly updateComplete: Promise<boolean>;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly execApprovalElement: OptionalCustomElement;
  readonly commandPalette: CommandPaletteElement | undefined;
  readonly approvalOverlay: (HTMLElement & { show(): void; dialogOpen?: boolean }) | undefined;
  navDrawerOpen: boolean;
  desktopNavigationExpanded: boolean;
  navDrawerTrigger: HTMLElement | null;
  nativeHistoryState: NativeHistoryState;
  commandPaletteTarget: CommandPaletteTargetDetail | undefined;
  requestUpdate(): void;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  exitSettings(): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  chatNavigationOptions(
    face: BoardFace,
    options?: ApplicationNavigationOptions,
  ): ApplicationNavigationOptions | undefined;
}

export class ShellChromeOwner {
  readonly panels: ShellPanelOwner;
  private readonly palette: ShellCommandPaletteOwner;
  private pendingLazyAction = readLazyShellAction();
  private listeners: AbortController | undefined;
  private disconnectViewport: (() => void) | undefined;
  private readonly navDrawerSwipe: NavDrawerSwipeLoader;
  constructor(private readonly host: ShellChromeHost) {
    this.palette = new ShellCommandPaletteOwner(host, {
      request: (element, event, replay) => this.requestLazyElement(element, event, replay),
      clear: (event) => this.clearPendingLazyAction(event),
      cancel: () => this.cancelPendingLazyAction(),
      pending: () => this.pendingLazyAction?.eventType === COMMAND_PALETTE_OPEN_EVENT,
    });
    this.panels = new ShellPanelOwner(host, (element, event) =>
      this.requestLazyElement(element, event),
    );
    this.navDrawerSwipe = new NavDrawerSwipeLoader(host, () => this.toggleNavigationSurface());
  }

  connect(): void {
    this.disconnect();
    this.listeners = new AbortController();
    this.disconnectViewport = connectShellViewport(this.host);
    // One connection owns all three targets; abort removes exactly its listeners.
    const options = { signal: this.listeners.signal };
    const host = this.host;
    host.nativeHistoryState = readNativeHistoryState();
    host.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget, options);
    document.addEventListener("keydown", this.handleDocumentKeydown, {
      capture: true,
      signal: this.listeners.signal,
    });
    document.addEventListener("keydown", this.handleDocumentKeydownBubble, options);
    window.addEventListener("dragover", this.handleUnhandledFileDrag, options);
    window.addEventListener("drop", this.handleUnhandledFileDrag, options);
    // Shipped Mac hosts use these same events even when native web chrome is absent.
    for (const [type, listener] of [
      [COMMAND_PALETTE_OPEN_EVENT, this.palette.open],
      [SHELL_NAV_DRAWER_TOGGLE_EVENT, this.handleShellNavDrawerToggle],
      [DEBUG_OVERLAY_REQUEST_EVENT, this.handleDebugOverlayRequest],
      [KEYBOARD_SHORTCUTS_REQUEST_EVENT, this.handleKeyboardShortcutsRequest],
      ["resize", this.handleWindowResize],
      [NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState],
      ["openclaw:native-toggle-sidebar", this.handleNativeToggleSidebar],
      ["openclaw:native-open-search", this.handleNativeOpenSearch],
      ["openclaw:native-toggle-search", this.handleNativeToggleSearch],
      ["openclaw:native-new-session", this.handleNativeNewSession],
      ["openclaw:native-navigate", this.handleNativeNavigate],
      [TERMINAL_PANEL_TOGGLE_EVENT, this.panels.handleDeferredTerminalToggle],
      [BROWSER_PANEL_TOGGLE_EVENT, this.panels.handleDeferredBrowserToggle],
      [LINK_READER_PANEL_TOGGLE_EVENT, this.panels.handleDeferredLinkReaderToggle],
      [DESKTOP_PANEL_TOGGLE_EVENT, this.panels.handleDeferredDesktopToggle],
      [CUSTODIAN_PANEL_TOGGLE_EVENT, this.handleAssistantToggleBeforeMount],
      [HOME_PANEL_TOGGLE_EVENT, this.handleAssistantToggleBeforeMount],
      [SHELL_APPROVALS_OPEN_EVENT, this.handleApprovalsOpen],
    ] as const) {
      window.addEventListener(type, listener, options);
    }
    this.navDrawerSwipe.connect();
    if (isMobileNavLayout()) {
      this.navDrawerSwipe.load();
    }
    // Document load can be a proxy sign-in page; the listener owner records readiness.
    nativeCommandsOwner = this.listeners;
    Object.assign(window, { __OPENCLAW_NATIVE_COMMANDS_READY__: true });
    window.dispatchEvent(new Event("openclaw:native-commands-state"));
  }

  disconnect(): void {
    this.commandPaletteLoading.clear();
    const listenerOwner = this.listeners;
    this.listeners?.abort();
    this.listeners = undefined;
    this.disconnectViewport?.();
    this.disconnectViewport = undefined;
    this.navDrawerSwipe.disconnect();
    if (listenerOwner && nativeCommandsOwner === listenerOwner) {
      nativeCommandsOwner = undefined;
      Object.assign(window, { __OPENCLAW_NATIVE_COMMANDS_READY__: false });
      window.dispatchEvent(new Event("openclaw:native-commands-state"));
    }
  }

  readonly toggleNavigationSurface = (trigger?: HTMLElement): void => {
    const host = this.host;
    const context = host.context;
    // Desktop settings takeover has no app nav; its mobile drawer still owns navigation.
    if (
      !context ||
      host.onboardingMode ||
      (isSettingsTakeover(host.routeState.routeId) && !isMobileNavLayout())
    ) {
      return;
    }
    if (isMobileNavLayout()) {
      this.navDrawerSwipe.load();
      if (host.navDrawerOpen) {
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      host.navDrawerTrigger = trigger ?? visibleNavDrawerToggle(host) ?? null;
      host.navDrawerOpen = true;
      moveToastToNavDrawer(host);
      if (!this.navDrawerSwipe.opened()) {
        void host.updateComplete.then(() => {
          if (host.isConnected && host.navDrawerOpen) {
            host.querySelector<HTMLElement>(".shell-nav")?.focus({ preventScroll: true });
          }
        });
      }
      return;
    }
    // A responsive handoff expands this shell without overwriting the desktop preference.
    const nextNavCollapsed =
      host.navDrawerOpen ||
      !(context.navigation.snapshot.navCollapsed && !host.desktopNavigationExpanded);
    host.desktopNavigationExpanded = false;
    if (nextNavCollapsed) {
      this.dismissSidebarTransientMenus();
    }
    host.closeNavDrawer();
    context.navigation.update({ navCollapsed: nextNavCollapsed });
    if (nextNavCollapsed) {
      void host.updateComplete.then(() => {
        this.restoreFocusTo(host.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle"));
      });
    }
  };

  /** Native Mac chrome hides in-page toggles, so restoration falls back to content. */
  restoreFocusTo = (target: HTMLElement | null | undefined): void =>
    focusWithoutTooltip(
      target?.isConnected && target.checkVisibility()
        ? target
        : this.host.querySelector<HTMLElement>(".content"),
    );

  readonly closeNavDrawer = (options: { restoreFocus?: boolean } = {}): void => {
    const host = this.host;
    // Desktop navigation also calls this cleanup; a closed drawer never owned focus.
    const restoreFocus = host.navDrawerOpen && options.restoreFocus;
    if (host.navDrawerOpen) {
      this.dismissSidebarTransientMenus();
      this.navDrawerSwipe.closed();
    }
    restoreToastFromNavDrawer(host);
    const trigger = restoreFocus ? host.navDrawerTrigger : null;
    host.navDrawerOpen = false;
    host.navDrawerTrigger = null;
    if (restoreFocus) {
      requestAnimationFrame(() => this.restoreFocusTo(trigger));
    }
  };

  readonly resizeNavigation = (splitRatio: number): void => {
    const host = this.host;
    const shell = host.querySelector<HTMLElement>(".shell");
    const context = host.context;
    if (!shell || !context) {
      return;
    }
    const navWidth = Math.round(
      Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, splitRatio * shell.clientWidth)),
    );
    context.navigation.update({ navWidth });
  };

  readonly handleNativeToggleSidebar = (): void => this.toggleNavigationSurface();
  readonly handleNativeOpenSearch = (): void => this.openPalette();

  readonly handleNativeToggleSearch = (event: Event): void => {
    event.preventDefault(); // Acknowledges toggle so native does not fall back to open-only search.
    this.togglePalette();
  };

  readonly handleNativeNewSession = (): void => {
    openShellNewSession(this.host, "native");
  };

  readonly handleNativeNavigate = (event: Event): void => {
    const detail = (event as CustomEvent<{ path?: unknown; search?: unknown }>).detail;
    const path = detail?.path;
    const schemeCandidate = typeof path === "string" ? path.slice(1) : "";
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /^[a-z][a-z\d+.-]*:/i.test(schemeCandidate)
    ) {
      return;
    }
    const routeId = routeIdFromPath(path);
    const context = this.host.context;
    if (!routeId || !context) {
      // Unhandled native routes remain eligible for the host's URL fallback.
      return;
    }
    event.preventDefault();
    // Native paths are relative to the Gateway mount. A route ID alone loses
    // the destination and can reopen the current session instead.
    const options: ApplicationNavigationOptions = { pathname: `${context.basePath}${path}` };
    const search = detail?.search;
    if (typeof search === "string" && search.startsWith("?") && !search.includes("#")) {
      options.search = search;
    }
    this.host.navigate(routeId, options);
  };

  readonly handleNativeHistoryState = (event: Event): void => {
    const detail = (event as CustomEvent<NativeHistoryState>).detail;
    if (typeof detail?.canGoBack !== "boolean" || typeof detail.canGoForward !== "boolean") {
      return;
    }
    this.host.nativeHistoryState = detail;
  };

  readonly handleWindowResize = (): void => {
    const host = this.host;
    const mobileNavLayout = isMobileNavLayout();
    // Dismiss the old surface before moving the shared sidebar between breakpoints.
    const dismissedSidebarMenus =
      mobileNavLayout && !host.navDrawerOpen && this.dismissSidebarTransientMenus();
    if (mobileNavLayout) {
      this.navDrawerSwipe.load();
      host.desktopNavigationExpanded = false;
    } else if (host.navDrawerOpen) {
      host.closeNavDrawer({ restoreFocus: false });
      // Preserve the tab-local state while keeping the responsive handoff expanded.
      host.desktopNavigationExpanded = host.context?.navigation.snapshot.navCollapsed ?? false;
    }
    host.requestUpdate();
    void host.updateComplete.then(() => {
      if (isMobileNavLayout() && !host.navDrawerOpen && dismissedSidebarMenus) {
        requestAnimationFrame(() => {
          this.restoreFocusTo(visibleNavDrawerToggle(host));
        });
      }
    });
  };

  readonly handleUnhandledFileDrag = (event: DragEvent): void => {
    // Bubble phase gives actual drop targets and native file inputs first refusal.
    const nativeFileInput = event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLInputElement && target.type === "file" && !target.disabled,
      );
    if (
      event.defaultPrevented ||
      nativeFileInput ||
      !Array.from(event.dataTransfer?.types ?? []).includes("Files")
    ) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };

  dismissSidebarTransientMenus = (): boolean => dismissNavigationTransientSurfaces(this.host);

  private readonly handleDocumentKeydownBubble = (event: KeyboardEvent): void => {
    const host = this.host;
    if (event.defaultPrevented || !matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
      return;
    }
    if (host.navDrawerOpen && isMobileNavLayout() && !document.openClawModalLayers?.size) {
      event.preventDefault();
      host.closeNavDrawer({ restoreFocus: true });
    } else if (
      isSettingsTakeover(host.routeState.routeId) &&
      !this.shouldIgnoreSettingsEscape(event)
    ) {
      event.preventDefault();
      host.exitSettings();
    }
  };

  readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    const host = this.host;
    if (
      host.lazyCustomElements.visibleState?.element === DEBUG_OVERLAY_ELEMENT &&
      shouldCloseDebugOverlay(
        event,
        this.pendingDebugOverlayMode,
        host.querySelector(".debug-overlay"),
      )
    ) {
      event.preventDefault();
      host.lazyCustomElements.close();
      return;
    }
    if (this.palette.handlePendingShortcut(event)) {
      return;
    }
    if (document.openClawModalLayers?.size) {
      return;
    }
    if (host.navDrawerOpen && isMobileNavLayout()) {
      handleNavDrawerKeydown(host, event);
      return;
    }
    if (!host.commandPalette && isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (
      isTerminalPanelShortcut(event) &&
      !isSessionRouteId(host.routeState.routeId) &&
      !event.defaultPrevented &&
      !host.onboardingMode &&
      !isSettingsTakeover(host.routeState.routeId) &&
      host.context &&
      isTerminalAvailable(
        host.context.gateway.snapshot,
        host.context.config.current.terminalEnabled ?? false,
      )
    ) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT));
      return;
    }
    if (isHomePanelShortcut(event) && isHomePanelAvailable(host.context?.gateway)) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      return;
    }
    if (event.defaultPrevented) {
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession, event)) {
      if (!event.repeat && openShellNewSession(this.host, "shortcut")) {
        event.preventDefault();
      }
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, event)) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_REQUEST_EVENT));
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, event)) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
      return;
    }
    if (
      matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event) &&
      isSettingsTakeover(host.routeState.routeId)
    ) {
      if (host.navDrawerOpen) {
        event.preventDefault();
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      if (event.eventPhase === Event.CAPTURING_PHASE || this.shouldIgnoreSettingsEscape(event)) {
        return;
      }
      event.preventDefault();
      host.exitSettings();
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings, event)) {
      event.preventDefault();
      host.navigate("appearance");
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar, event)) {
      event.preventDefault();
      this.toggleNavigationSurface();
    }
  };

  get pendingDebugOverlayMode(): DebugOverlayMode {
    return readDebugOverlayMode(this.pendingLazyAction);
  }

  togglePendingDebugOverlayMode(): void {
    const event = this.pendingLazyAction;
    if (
      event?.eventType !== DEBUG_OVERLAY_REQUEST_EVENT ||
      this.host.lazyCustomElements.visibleState?.element !== DEBUG_OVERLAY_ELEMENT
    ) {
      return;
    }
    event.detail = {
      mode: this.pendingDebugOverlayMode === "minimized" ? "expanded" : "minimized",
    };
    persistLazyShellAction(event);
    this.host.requestUpdate();
  }

  private readonly handleDebugOverlayRequest = (event: Event): void => {
    const host = this.host;
    if (host.navDrawerOpen && isMobileNavLayout()) {
      host.closeNavDrawer({ restoreFocus: false });
    }
    if (host.lazyCustomElements.visibleState?.element === DEBUG_OVERLAY_ELEMENT) {
      if (this.pendingDebugOverlayMode === "minimized") {
        this.togglePendingDebugOverlayMode();
      } else {
        host.lazyCustomElements.close();
      }
      return;
    }
    const descriptor = lazyShellEvent(DEBUG_OVERLAY_REQUEST_EVENT, event);
    const overlay = isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT)
      ? host.querySelector<DebugOverlayElement>(DEBUG_OVERLAY_ELEMENT.tagName)
      : null;
    if (overlay) {
      this.clearPendingLazyAction(descriptor);
      if (descriptor.detail && "mode" in descriptor.detail) {
        overlay.open(readDebugOverlayMode(descriptor));
      } else {
        overlay.toggle();
      }
      return;
    }
    this.requestLazyElement(DEBUG_OVERLAY_ELEMENT, descriptor, () => {
      if (this.pendingLazyAction !== descriptor) {
        return;
      }
      const mounted = host.querySelector<DebugOverlayElement>(DEBUG_OVERLAY_ELEMENT.tagName);
      if (!mounted) {
        return;
      }
      const mode = this.pendingDebugOverlayMode;
      // Opening starts inner-content recovery. Retire only the outer intent first,
      // or the shell would erase the new reload action recorded by the overlay.
      this.clearPendingLazyAction(descriptor);
      mounted.open(mode);
    });
  };

  private readonly handleAssistantToggleBeforeMount = (event: Event): void => {
    const host = this.host;
    if (host.querySelector("openclaw-assistant-panel")) {
      return;
    }
    const home = event.type === HOME_PANEL_TOGGLE_EVENT;
    if (
      home
        ? !isHomePanelAvailable(host.context?.gateway)
        : !canCallGatewayMethod(host.context?.gateway.snapshot, "openclaw.chat", "operator.admin")
    ) {
      event.preventDefault();
      return;
    }
    // Native commands can arrive before the eager frame's first render.
    const descriptor = lazyShellEvent(
      home ? HOME_PANEL_TOGGLE_EVENT : CUSTODIAN_PANEL_TOGGLE_EVENT,
      event,
    );
    this.pendingLazyAction = descriptor;
    persistLazyShellAction(descriptor);
    host.requestUpdate();
  };

  private readonly handleKeyboardShortcutsRequest = (event: Event): void => {
    const descriptor = lazyShellEvent(KEYBOARD_SHORTCUTS_REQUEST_EVENT, event);
    if (isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)) {
      this.host
        .querySelector<KeyboardShortcutsDialogElement>(KEYBOARD_SHORTCUTS_ELEMENT.tagName)
        ?.toggle();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(KEYBOARD_SHORTCUTS_ELEMENT, descriptor);
  };

  // Open controls own Escape. Slotted items hide their menu/listbox in shadow DOM,
  // so recognize the open control host before Settings can consume the key.
  shouldIgnoreSettingsEscape(event: KeyboardEvent): boolean {
    const host = this.host;
    const overlaySnapshot = host.context?.overlays.snapshot;
    if (
      host.commandPalette?.isOpen ||
      host.querySelector<KeyboardShortcutsDialogElement>(KEYBOARD_SHORTCUTS_ELEMENT.tagName)
        ?.isOpen ||
      overlaySnapshot?.devicePairSetupOpen ||
      host.approvalOverlay?.dialogOpen === true ||
      document.openClawModalLayers?.size
    ) {
      return true;
    }
    const target = event.target;
    return (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, wa-select[open], wa-dropdown[open], [contenteditable], dialog, [role='dialog'], [role='menu'], [role='listbox']",
      ) !== null
    );
  }

  get commandPaletteLoading() {
    return this.palette.loading;
  }

  readonly openPalette = (): void => this.palette.open();
  readonly closePendingPalette = (): void => this.palette.closePending();
  readonly togglePalette = (): void => this.palette.toggle();
  synchronizeCommandPaletteScope(): void {
    this.palette.synchronizeScope();
  }

  readonly handleShellNavDrawerToggle = (event: Event): void => {
    this.toggleNavigationSurface(shellNavDrawerTriggerFromEvent(event));
  };

  private readonly handleApprovalsOpen = (event: Event): void => {
    const host = this.host;
    const descriptor = lazyShellEvent(SHELL_APPROVALS_OPEN_EVENT, event);
    if (isOptionalElementDefined(host.execApprovalElement)) {
      host.approvalOverlay?.show();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(host.execApprovalElement, descriptor);
  };

  private shellEventElementTag(eventType: LazyShellEvent["eventType"]): string {
    const host = this.host;
    const elements: Record<LazyShellEvent["eventType"], string> = {
      [COMMAND_PALETTE_OPEN_EVENT]: host.commandPaletteElement.tagName,
      [DEBUG_OVERLAY_REQUEST_EVENT]: DEBUG_OVERLAY_ELEMENT.tagName,
      [KEYBOARD_SHORTCUTS_REQUEST_EVENT]: KEYBOARD_SHORTCUTS_ELEMENT.tagName,
      [TERMINAL_PANEL_TOGGLE_EVENT]: host.terminalPanelElement.tagName,
      [BROWSER_PANEL_TOGGLE_EVENT]: host.browserPanelElement.tagName,
      [LINK_READER_PANEL_TOGGLE_EVENT]: host.linkReaderPanelElement.tagName,
      [DESKTOP_PANEL_TOGGLE_EVENT]: host.desktopPanelElement.tagName,
      [CUSTODIAN_PANEL_TOGGLE_EVENT]: "openclaw-assistant-panel",
      [HOME_PANEL_TOGGLE_EVENT]: "openclaw-assistant-panel",
      [SHELL_APPROVALS_OPEN_EVENT]: host.execApprovalElement.tagName,
    };
    return elements[eventType];
  }

  readonly restorePendingLazyAction = (): void => {
    const event = this.pendingLazyAction;
    if (
      !event ||
      this.host.lazyCustomElements.visibleState ||
      this.commandPaletteLoading.waitingForComposition
    ) {
      return;
    }
    const tagName = this.shellEventElementTag(event.eventType);
    if (customElements.get(tagName) && !this.host.querySelector(tagName)) {
      // Loaded but render-gated (e.g. the shell is still booting): nothing can
      // consume the dispatch yet, and re-dispatching re-arms a request/update
      // cycle whose microtasks starve the boot (Gateway socket included).
      // The host retries after every completed update, so the replay fires on
      // the update that first renders the element.
      return;
    }
    if (this.dispatchLazyShellEvent(event) && !this.host.lazyCustomElements.visibleState) {
      this.clearPendingLazyAction(event);
    }
  };

  private requestLazyElement(
    element: OptionalCustomElement,
    event: LazyShellEvent,
    replay: () => unknown = () => this.dispatchLazyShellEvent(event),
  ): void {
    if (element !== this.host.commandPaletteElement) {
      this.commandPaletteLoading.clear();
    }
    this.pendingLazyAction = event;
    persistLazyShellAction(event);
    this.host.lazyCustomElements.request(element, () => {
      replay();
      this.clearPendingLazyAction(event);
    });
  }

  retryPendingLazyAction(canReload: () => boolean): Promise<boolean> {
    const event = this.pendingLazyAction;
    // Render-owned surfaces need recovery too, but have no user action to persist for replay.
    return retryStaleChunkReloadWhenReachable({
      canReload: () =>
        canReload() &&
        this.pendingLazyAction === event &&
        (!event || persistLazyShellAction(event)),
    });
  }

  private dispatchLazyShellEvent({ eventType, detail }: LazyShellEvent): boolean {
    return window.dispatchEvent(new CustomEvent(eventType, { cancelable: true, detail }));
  }

  private clearPendingLazyAction(event: LazyShellEvent): void {
    if (JSON.stringify(this.pendingLazyAction) !== JSON.stringify(event)) {
      return;
    }
    clearLazyShellAction();
    this.pendingLazyAction = null;
  }

  cancelPendingLazyAction(): void {
    this.commandPaletteLoading.clear();
    const event = this.pendingLazyAction;
    if (event) {
      this.clearPendingLazyAction(event);
    }
  }

  abandonPendingLazyActionForContext(): void {
    this.commandPaletteLoading.clear();
    this.panels.reset();
    this.pendingLazyAction = null;
    clearLazyShellAction();
    this.host.lazyCustomElements.abandon();
  }

  preservePendingLazyActionForReload(): void {
    this.panels.reset();
    this.host.lazyCustomElements.abandon();
  }

  readonly handleCommandPaletteSlashCommand = (command: string): void =>
    this.palette.handleSlashCommand(command);

  readonly handleCommandPaletteTarget = (event: Event): void =>
    applyCommandPaletteTargetEvent(this.host, event);

  readonly nativeNavCollapsed = (): boolean => {
    const host = this.host;
    const mobileNavLayout = isMobileNavLayout();
    return (
      host.onboardingMode ||
      mobileNavLayout ||
      (isSettingsTakeover(host.routeState.routeId) && !mobileNavLayout) ||
      (!host.navDrawerOpen &&
        !host.desktopNavigationExpanded &&
        (host.context?.navigation.snapshot.navCollapsed ?? false))
    );
  };
}
