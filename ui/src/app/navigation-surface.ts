import { isSessionRouteId } from "../app-route-paths.ts";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { activeElement, tabbableElements } from "../components/focus-navigation.ts";
import { containsComposed } from "../components/overlay-registry.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import type { RouteElements } from "./route-elements.ts";

export const NAVIGATION_RAIL_WIDTH = 52;
export const NAV_DRAWER_TOGGLE_REGISTRATION = "nav-drawer-toggle";

export type ShellNavigationElements = {
  shellElement?: HTMLElement;
  navDrawerElement?: HTMLElement;
  navBackdropElement?: HTMLElement;
  contentElement?: HTMLElement;
  toastElement?: HTMLElement;
};

export type ShellNavigationSurfaces = {
  readonly element: HTMLElement;
  readonly navigationSidebar: HTMLElement &
    Partial<
      Pick<
        AppSidebarElement,
        "dismissTransientMenus" | "activeNavigationViewElement" | "selectAdjacentSession"
      >
    >;
  readonly queryRenderedElements: RouteElements["renderedElements"];
};

export function dismissNavigationTransientSurfaces(host: ShellNavigationSurfaces): boolean {
  const dismissedPanel = host
    .queryRenderedElements("openclaw-sidebar-attention")
    .map((attention) => attention.dismissPanel())
    .some((dismissed) => dismissed);
  const sidebar = host.navigationSidebar;
  const dismissedMenu = host.element.contains(sidebar) && sidebar.dismissTransientMenus?.();
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
  const focusable = [...tabbableElements(drawer.children)];
  const active = activeElement(drawer);
  const target = event.shiftKey ? focusable.at(-1) : focusable[0];
  const boundary = event.shiftKey ? focusable[0] : focusable.at(-1);
  if (
    !active ||
    !containsComposed(drawer, active) ||
    active === boundary ||
    (event.shiftKey && active === drawer)
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

export function visibleNavDrawerToggle(
  host: Pick<ShellNavigationSurfaces, "queryRenderedElements">,
): HTMLElement | undefined {
  return host
    .queryRenderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)
    .toSorted((left, right) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .find((candidate) => candidate.checkVisibility());
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

interface SessionShortcutHost {
  readonly element: HTMLElement;
  readonly onboardingMode: boolean;
  readonly routeState: { readonly routeId?: string | undefined };
  readonly navigationSidebar: HTMLElement & {
    selectAdjacentSession?: (direction: -1 | 1) => boolean;
  };
}

export class ShellSessionShortcuts {
  private claimedKey: string | null = null;

  constructor(
    private readonly host: SessionShortcutHost,
    private readonly shouldIgnore: (event: KeyboardEvent) => boolean,
  ) {}

  readonly release = (): void => {
    this.claimedKey = null;
  };

  handleKeydown(event: KeyboardEvent): boolean {
    const previous = event.key === "[";
    if (
      !matchesShortcutCombo(
        KEYBOARD_SHORTCUT_COMBOS[previous ? "previousSession" : "nextSession"],
        event,
      )
    ) {
      return false;
    }
    // Selection can autofocus the new composer. Keep a held chord from falling
    // through to browser history, even after focus or the route changes.
    if (event.repeat && this.claimedKey === event.key) {
      event.preventDefault();
      return true;
    }
    const host = this.host;
    if (
      !event.defaultPrevented &&
      !event.repeat &&
      !host.onboardingMode &&
      isSessionRouteId(host.routeState.routeId) &&
      !this.shouldIgnore(event) &&
      host.element.contains(host.navigationSidebar) &&
      host.navigationSidebar.selectAdjacentSession?.(previous ? -1 : 1)
    ) {
      this.claimedKey = event.key;
      event.preventDefault();
    }
    return true;
  }

  dispatchNative(key: "[" | "]"): void {
    // AppKit consumes menu equivalents before WebKit delivers keydown. Re-enter
    // through the focused control so the normal editable and overlay guards apply.
    const target = activeElement(this.host.element);
    // Ordinary keydown never crosses a browsing-context boundary either.
    if (target instanceof HTMLIFrameElement) {
      return;
    }
    (target ?? document).dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }
}
