import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { projectSidebarSessionReference } from "./app-sidebar-agent-session-rows.ts";
import type {
  CatalogBackingSessionDisplay,
  SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { sidebarCatalogLiveRows } from "./app-sidebar-session-snooze-visibility.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarProjectionMemo } from "./sidebar-projection-cache.ts";
import type { SidebarProjectionHost } from "./sidebar-projection-memo.ts";

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

/** Converted entries share one prepared tree map across disclosure, rendering and activity. */
export function memoizedSidebarCatalogRows(
  memo: SidebarProjectionMemo<ReadonlyMap<string, SidebarRecentSession>>,
  host: SidebarProjectionHost,
  catalogs: readonly SidebarSessionCatalog[],
): ReadonlyMap<string, SidebarRecentSession> {
  const navigationState = host.getSessionNavigationState();
  return memo.read(
    () => [
      navigationState,
      catalogs,
      host.sessionData.loadedChildSessionKeys,
      host.sessionData.childSessionErrorsByParent,
    ],
    () => {
      const adopted = new Set<string>();
      for (const catalog of catalogs) {
        for (const source of catalog.visibleHosts) {
          for (const entry of source.sessions) {
            if (entry.sessionKey) {
              adopted.add(entry.sessionKey);
            }
          }
        }
      }
      const projected = new Map<string, SidebarRecentSession>();
      for (const row of sidebarCatalogLiveRows(host.sessionData)) {
        if (adopted.has(row.key) && !projected.has(row.key)) {
          projected.set(
            row.key,
            projectSidebarSessionReference({
              host,
              row,
              agentId: host.sessionNavigationAgentId(row),
              navigationState,
              resolveAttention: host.resolveSessionAttention,
              involvingMe: host.sessionInvolvingMeFilterActive,
              ownerId: host.sessionOwnerFilterId,
            }).session,
          );
        }
      }
      return projected;
    },
  );
}
