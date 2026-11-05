import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { CatalogBackingSessionDisplay } from "./app-sidebar-session-catalogs.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";

const CATALOG_CONTROLS = [
  ["link", ".sidebar-recent-session__link"],
  ["children", "[data-child-session-toggle]"],
  ["pin", "[data-sidebar-session-pin]"],
  ["archive", "[data-sidebar-session-archive]"],
  ["menu", "[data-sidebar-session-menu]"],
  ["catalogMenu", "[data-catalog-session-menu]"],
] as const;

export function createCatalogSessionRowRef(
  host: Pick<SessionListHost, "sessionProjection" | "sidebarMenus">,
  readRow: () => {
    key: string;
    identityKey: string;
    catalogKey: CatalogSessionKey;
    nativeSessionKey: string | undefined;
  },
): NonNullable<CatalogBackingSessionDisplay["rowRef"]> {
  // Menu focus lives outside the row while its replacement mounts.
  let restoreReleasedMenuFocus = false;
  return (element, controls, previousFocus) => {
    const row = readRow();
    const mountedSessionKey = row.nativeSessionKey;
    const stop = host.sessionProjection.mountCatalogRow(row.key);
    const catalogMenuOpen = host.sidebarMenus.catalogMenu.isOpenFor(row.catalogKey);
    const restoreOwnerFocus =
      restoreReleasedMenuFocus || Boolean(mountedSessionKey && catalogMenuOpen);
    restoreReleasedMenuFocus = false;
    const active = previousFocus instanceof HTMLElement ? previousFocus : null;
    const activeRow = active?.closest<HTMLElement>("[data-session-key]");
    const control =
      CATALOG_CONTROLS.find(([, selector]) => active?.matches(selector))?.[0] ??
      (restoreOwnerFocus ? "link" : undefined);
    const restoreFocus =
      control !== undefined &&
      (restoreOwnerFocus ||
        activeRow?.dataset.catalogSessionKey === row.identityKey ||
        activeRow?.dataset.sessionKey === row.identityKey ||
        activeRow?.dataset.sessionKey === row.key);
    if (catalogMenuOpen) {
      if (mountedSessionKey) {
        host.sidebarMenus.catalogMenu.close();
      } else {
        host.sidebarMenus.catalogMenu.retargetTrigger(
          row.catalogKey,
          controls.catalogMenu ?? controls.link,
        );
      }
    }
    if (restoreFocus && control) {
      queueMicrotask(() => {
        if (element.isConnected && document.activeElement === document.body) {
          const focusTarget = controls[control];
          (focusTarget && element.contains(focusTarget) ? focusTarget : controls.link)?.focus({
            preventScroll: true,
          });
        }
      });
    }
    return () => {
      stop();
      // Releasing an adopted row must also release its native menu and trigger.
      if (mountedSessionKey && host.sidebarMenus.sessionMenu?.session.key === mountedSessionKey) {
        restoreReleasedMenuFocus = true;
        host.sidebarMenus.closeSessionMenu();
      }
    };
  };
}
