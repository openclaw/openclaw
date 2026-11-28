import type { SessionCatalogSession } from "../../../packages/gateway-protocol/src/index.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  type CatalogProjectGrouping,
} from "../lib/sessions/catalog-project-grouping.ts";
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

export type SidebarCatalogRuntime = {
  memoizedSidebarCatalogRows: typeof memoizedSidebarCatalogRows;
  revealSidebarCatalogSelection: typeof revealSidebarCatalogSelection;
};

export const CATALOG_SESSION_GROUP_LIMIT = 5;

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

export function catalogSessionGroups(
  sessions: readonly SessionCatalogSession[],
  grouping: CatalogProjectGrouping,
) {
  return grouping === "project"
    ? groupCatalogSessionsByProject(sessions)
    : grouping === "person"
      ? groupCatalogSessionsByPerson(sessions)
      : null;
}

/** The lazy placement owner reveals every boundary once per native navigation epoch. */
export function revealSidebarCatalogSelection(
  host: SidebarProjectionHost &
    Pick<SessionListHost, "toggleSection" | "setVisibleSessionLimit"> & {
      readonly catalogProjectGrouping: CatalogProjectGrouping;
    },
  catalogs: readonly SidebarSessionCatalog[],
) {
  const disclosure = host.sessionProjection.children;
  const row = host.catalogSessionRows().get(disclosure.selectedRootKey ?? "");
  if (!row?.containsActiveDescendant) {
    return;
  }
  const revealSection = (id: string) => {
    if (disclosure.revealOnce("section:" + id) && host.collapsedSessionSections.has(id)) {
      host.toggleSection(id);
    }
  };
  for (const catalog of catalogs) {
    for (const source of catalog.visibleHosts) {
      if (!source.sessions.some((entry) => entry.sessionKey === row.key)) {
        continue;
      }
      revealSection(`catalog:${catalog.id}`);
      const grouped = catalogSessionGroups(source.sessions, host.catalogProjectGrouping);
      const group = grouped?.groups.find((entry) =>
        entry.sessions.some((session) => session.sessionKey === row.key),
      );
      const sectionId = group
        ? `catalog-${group.kind}:${catalog.id}:${source.hostId}:${group.key}`
        : grouped
          ? `catalog-${host.catalogProjectGrouping}-ungrouped:${catalog.id}:${source.hostId}`
          : `catalog-host:${catalog.id}:${source.hostId}`;
      if (group) {
        revealSection(sectionId);
        if (group.legacySectionKey) {
          revealSection(`catalog-project:${catalog.id}:${source.hostId}:${group.legacySectionKey}`);
        }
      }
      const sessions = group?.sessions ?? grouped?.ungrouped ?? source.sessions;
      const index = sessions.findIndex((entry) => entry.sessionKey === row.key);
      if (disclosure.revealOnce("page:" + sectionId) && index >= CATALOG_SESSION_GROUP_LIMIT) {
        host.setVisibleSessionLimit(sectionId, sessions.length);
      }
      return;
    }
  }
}
