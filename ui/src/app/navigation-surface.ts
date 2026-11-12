import { routeIdFromPath } from "../app-route-paths.ts";
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

/** Native menu equivalents re-enter the focused control's normal keyboard guards. */
export function dispatchNativeSessionShortcut(element: HTMLElement, key: "[" | "]"): void {
  const target = activeElement(element);
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

/** Validate native routes before acknowledging them; unknown routes retain native fallback. */
export function nativeNavigationTarget(event: Event, basePath: string) {
  const detail = (event as CustomEvent<{ path?: unknown; search?: unknown }>).detail;
  const path = detail?.path;
  const schemeCandidate = typeof path === "string" ? path.slice(1) : "";
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(schemeCandidate)
  ) {
    return undefined;
  }
  const routeId = routeIdFromPath(path);
  if (!routeId) {
    return undefined;
  }
  // Preserve the destination within the Gateway mount, not only the route ID.
  const options: { pathname: string; search?: string } = { pathname: `${basePath}${path}` };
  const search = detail?.search;
  if (typeof search === "string" && search.startsWith("?") && !search.includes("#")) {
    options.search = search;
  }
  return { routeId, options };
}
