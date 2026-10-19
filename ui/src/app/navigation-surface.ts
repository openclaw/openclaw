import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";

export const NAVIGATION_RAIL_WIDTH = 52;

export type ShellNavigationElements = {
  shellElement?: HTMLElement;
  navDrawerElement?: HTMLElement;
  contentElement?: HTMLElement;
  toastElement?: HTMLElement;
};

const NAV_DRAWER_FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

type AppSidebarElement = HTMLElement & { dismissTransientMenus(): boolean };
type SidebarAttentionElement = HTMLElement & { dismissPanel(): boolean };

export function navDrawerFocusableElements(drawer: HTMLElement): HTMLElement[] {
  // Sidebar and route owners can replace descendants; tab trapping needs their live focus order.
  return [...drawer.querySelectorAll<HTMLElement>(NAV_DRAWER_FOCUSABLE_SELECTOR)].filter(
    (candidate) => candidate.checkVisibility(),
  );
}

export function dismissNavigationTransientSurfaces(host: HTMLElement): boolean {
  // Sidebar-owned menu/panel markup stays foreign; unupgraded elements own no transient UI.
  const dismissedPanel = [
    ...host.querySelectorAll<SidebarAttentionElement>("openclaw-sidebar-attention:defined"),
  ]
    .map((attention) => attention.dismissPanel())
    .some((dismissed) => dismissed);
  const dismissedMenu = host
    .querySelector<AppSidebarElement>("openclaw-app-sidebar:defined")
    ?.dismissTransientMenus();
  return dismissedMenu === true || dismissedPanel;
}

function trapNavDrawerFocus(drawer: HTMLElement | undefined, event: KeyboardEvent): void {
  if (!drawer) {
    return;
  }
  if (
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target !== drawer &&
          target.matches("dialog, [role='dialog']"),
      )
  ) {
    return;
  }
  const focusable = navDrawerFocusableElements(drawer);
  const target = event.shiftKey ? focusable.at(-1) : focusable[0];
  const boundary = event.shiftKey ? focusable[0] : focusable.at(-1);
  if (
    !drawer.contains(document.activeElement) ||
    document.activeElement === boundary ||
    (event.shiftKey && document.activeElement === drawer)
  ) {
    event.preventDefault();
    (target ?? drawer).focus({ preventScroll: true });
  }
}

export function handleNavDrawerKeydown(
  host: Pick<ShellNavigationElements, "navDrawerElement"> & {
    closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  },
  event: KeyboardEvent,
): void {
  if (event.defaultPrevented) {
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar, event)) {
    event.preventDefault();
    host.closeNavDrawer({ restoreFocus: true });
  } else if (event.key === "Tab") {
    trapNavDrawerFocus(host.navDrawerElement, event);
  } else if (
    isCommandPaletteShortcut(event) ||
    isTerminalPanelShortcut(event) ||
    matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles, event) ||
    matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sideChat, event)
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

export function setToastInNavDrawer(host: ShellNavigationElements, inDrawer: boolean): void {
  const toast = host.toastElement;
  const source = toast?.parentElement;
  const target = inDrawer ? host.navDrawerElement : host.shellElement;
  if (toast && target && source !== target && (inDrawer || source === host.navDrawerElement)) {
    target.append(toast);
  }
}

export function visibleNavDrawerToggle(host: HTMLElement): HTMLElement | undefined {
  // Topbar and chat own separate triggers; select whichever surface is currently visible.
  return [...host.querySelectorAll<HTMLElement>(".topbar-nav-toggle, .chat-pane__nav-toggle")].find(
    (candidate) => candidate.checkVisibility(),
  );
}

export function navigationSurfaceIsHidden(params: {
  onboarding: boolean;
  navCollapsed: boolean;
  navDrawerOpen: boolean;
  mobileNavLayout: boolean;
  railAvailable?: boolean;
}): boolean {
  return (
    params.onboarding ||
    (params.mobileNavLayout ? !params.navDrawerOpen : params.navCollapsed && !params.railAvailable)
  );
}

export function floatingSidebarAttentionVisible(params: {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  compact?: boolean;
}): boolean {
  const attentionNeedsFloating =
    params.navigationSurfaceHidden && !params.mobileNavLayout && !params.onboarding;
  return attentionNeedsFloating && !params.compact;
}
