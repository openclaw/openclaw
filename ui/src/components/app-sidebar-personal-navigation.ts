import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry, type NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import type {
  SessionConnectionScope,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import { buildReconciledSidebarZone } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import {
  setStoredSessionCatalogHidden,
  type SidebarRecentSession,
  type SidebarPinZone,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";
import type { SessionOwnerFilter } from "./session-owner-filter.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type PersonalNavigationHost = {
  readonly pinnedSessions: ReturnType<typeof createSidebarPinnedSessions>;
  readonly sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
  readonly sidebarEntries: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  readonly sessionDataContext:
    | Pick<ApplicationContext, "sessions" | "gateway" | "plugins" | "connectionBootstrap">
    | undefined;
  readonly navigationCatalog: { readonly dashboards: SessionListSnapshot | null };
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  findSidebarSessionByKey(key: string): SidebarRecentSession | undefined;
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

export function hidePersonalSidebarCatalog(
  host: {
    readonly sessionData: {
      readonly sessionCatalogs: ReadonlyArray<{ id: string; label?: string | null }>;
    };
    readonly basePath: string;
    readonly ownerDocument: Document;
    readonly onNavigate:
      | ((routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void)
      | undefined;
  },
  catalogId: string,
): void {
  const label =
    host.sessionData.sessionCatalogs.find((catalog) => catalog.id === catalogId)?.label ??
    catalogId;
  setStoredSessionCatalogHidden(catalogId, true);
  // Reuse the settings-search destination for the Sidebar preferences block so the
  // toast opens the same place the rest of the app calls "Appearance > Sidebar".
  const recovery = SETTINGS_ROUTE_TARGETS.appearanceSidebar;
  const recoveryHref =
    pathForRoute(recovery.routeId, host.basePath) + recovery.search + recovery.hash;
  // The section disappears instantly and its only standing recovery lives on another
  // page, so the outcome is announced where the action happened: undo here, plus a
  // link that opens the re-enable block for after the toast is gone. Longer than the
  // 6s default because that text is a recovery instruction, not an acknowledgement.
  const message = host.ownerDocument.createDocumentFragment();
  const recoveryLink = host.ownerDocument.createElement("a");
  recoveryLink.className = "session-link";
  recoveryLink.href = recoveryHref;
  recoveryLink.textContent = t("chat.sidebar.sectionHiddenRecovery");
  listen(recoveryLink, "click", (event) =>
    handleNavigationClick(event, () =>
      host.onNavigate?.(recovery.routeId, { search: recovery.search, hash: recovery.hash }),
    ),
  );
  message.append(t("chat.sidebar.sectionHidden", { section: label }), " ", recoveryLink);
  showToast({
    message,
    actionLabel: t("common.undo"),
    onAction: () => setStoredSessionCatalogHidden(catalogId, false),
    durationMs: 12_000,
  });
}

/** Descriptor snapshots last one connection; loaded rows always supersede them. */
export function createSidebarPinnedSessions(
  host: Pick<
    PersonalNavigationHost,
    "sessionDataContext" | "findSidebarSessionByKey" | "navigationCatalog"
  > & {
    readonly isConnected: boolean;
    readonly sessionData: Pick<SessionDataOwner, "requestSessionDataUpdate">;
  },
) {
  let source: ApplicationContext["sessions"] | undefined;
  let scope: SessionConnectionScope | null = null;
  const requested = new Map<string, "pending" | "settled">();
  const rows = new Map<string, GatewaySessionRow>();

  function synchronize() {
    const nextSource = host.sessionDataContext?.sessions;
    if (nextSource !== source || !scope || !nextSource?.isConnectionScopeCurrent(scope)) {
      requested.clear();
      rows.clear();
      source = nextSource;
      scope = source?.captureConnectionScope() ?? null;
    }
    return source;
  }

  function seed(snapshot: SidebarSnapshotModel["pinnedSessions"]): void {
    synchronize();
    if (!scope) {
      return;
    }
    for (const row of snapshot) {
      if (!rows.has(row.key) && requested.get(row.key) !== "settled") {
        rows.set(row.key, {
          key: row.key,
          kind: "direct",
          updatedAt: null,
          agentId: row.agentId,
          label: row.label,
          icon: row.icon,
          color: row.color,
          pinned: row.pinned,
          archived: row.archived,
          boardFace: row.boardFace,
        });
      }
    }
  }

  function get(key: string): GatewaySessionRow | undefined {
    const context = host.sessionDataContext;
    const currentSource = synchronize();
    const currentScope = scope;
    if (!host.isConnected || !currentSource || !currentScope || !context) {
      return undefined;
    }
    if (!requested.has(key)) {
      requested.set(key, "pending");
      const current = () =>
        source === currentSource &&
        host.sessionDataContext === context &&
        scope === currentScope &&
        currentSource.isConnectionScopeCurrent(currentScope);
      const publish = (row?: GatewaySessionRow | null) => {
        if (!current()) {
          return;
        }
        requested.set(key, "settled");
        if (row) {
          rows.set(key, row);
        } else if (!rows.delete(key)) {
          return;
        }
        if (host.isConnected) {
          host.sessionData.requestSessionDataUpdate();
        }
      };
      const describe = async () => {
        if (!current()) {
          return;
        }
        // The roster can supply a pin while its lookup waits behind foreground bootstrap.
        if (
          !host.isConnected ||
          host.findSidebarSessionByKey(key) ||
          host.navigationCatalog.dashboards?.result?.sessions.some((row) => row.key === key)
        ) {
          requested.delete(key);
          return;
        }
        await currentSource.describe({ key }).then(
          (result) => publish(result.session),
          () => {
            /* Missing or failed pins stay saved, invisible, and silent. */
            publish();
          },
        );
      };
      // Cached pins can paint while the selected conversation takes the request budget.
      void context.connectionBootstrap.run(describe, describe, { background: true });
    }
    return rows.get(key);
  }

  return { synchronize, seed, get };
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  const pins = (host.sidebarSnapshot ? [] : host.sidebarEntries).flatMap((value) => {
    const entry = parseSidebarEntry(value);
    if (entry?.type !== "session") {
      return [];
    }
    const loaded = host.findSidebarSessionByKey(entry.key);
    const snapshot = loaded
      ? undefined
      : (host.navigationCatalog.dashboards?.result?.sessions.find((row) => row.key === entry.key) ??
        host.pinnedSessions.get(entry.key));
    const row =
      loaded ??
      (snapshot ? host.getSessionNavigationState().toSidebarSession(snapshot) : undefined);
    return row ? [row] : [];
  });
  return buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...pins, ...rows],
    pluginNavigation: host.pluginNavigation(),
    pluginTabs: host.sessionDataContext?.gateway.snapshot.hello?.controlUiTabs,
    snapshot: host.sidebarSnapshot
      ? { model: host.sidebarSnapshot, selectedKey: host.getRouteSessionKey() }
      : undefined,
    pendingPlugins:
      host.sessionDataContext?.plugins.registryStatus !== "complete"
        ? host.sidebarPluginSnapshot
        : null,
  });
}

export function projectUnpinnedSessionRows(
  rows: readonly SidebarRecentSession[],
): SidebarRecentSession[] {
  return rows.map((row) => ({
    ...row,
    pinned: false,
    children: projectUnpinnedSessionRows(row.children),
  }));
}

export function personalSidebarOwnerFilterId(
  host: PersonalNavigationHost & {
    readonly sidebarAgentsMode: "chip" | "roster";
    readonly sessionOwnerFilter: SessionOwnerFilter;
    expandedAgentId(): string;
  },
): string | null {
  if (host.sidebarSnapshot) {
    return host.sidebarSnapshot.ownerId;
  }
  const agentId = host.sidebarAgentsMode === "roster" ? "*" : host.expandedAgentId();
  const hasMultipleOwners = host.sessionOwnerFilter.hasMultipleOwners(agentId);
  const ownerId = host.sessionOwnerFilter.read().ownerId;
  const context = host.sessionDataContext;
  // Solo installs must include legacy sessions without owner metadata.
  return ownerId ===
    (context ? gatewayPresentationScope(context.gateway).displayUser?.id : undefined) &&
    context?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === false &&
    !hasMultipleOwners
    ? null
    : ownerId;
}

export function personalSidebarOwnerProjection(
  host: PersonalNavigationHost,
  projected: SidebarRecentSession[],
  ownerFacet: SessionsListResult["owners"],
) {
  const context = host.sessionDataContext;
  const self = context ? gatewayPresentationScope(context.gateway).displayUser : null;
  return applySidebarSessionOwnerFilter({
    projected,
    ownerFacet,
    selectedOwnerId: host.sessionOwnerFilterId,
    selectedProfileId: host.sessionOwnerFilterId === self?.id ? self.id : undefined,
    self,
  });
}

/** Rendering and selection share archive visibility; saved pins survive restoration. */
export function sidebarPinnedSessionRows(
  zone: SidebarPinZone,
  archiveVisibility?: ApplicationContext["sessions"]["archiveVisibility"],
): SidebarRecentSession[] {
  return zone.entries.flatMap((entry) => {
    const row =
      entry.type === "session" && !entry.rail ? zone.sessionRows.get(entry.key) : undefined;
    return row && row.archived !== true && !archiveVisibility?.(row.key) ? [row] : [];
  });
}

export function sidebarVisibleRowsInOrder(
  zone: SidebarPinZone,
  visibleRows: SidebarRecentSession[],
  host: {
    readonly collapsedSessionSections: ReadonlySet<string>;
    readonly sessionDataContext?: {
      sessions: Pick<ApplicationContext["sessions"], "archiveVisibility">;
    };
  },
): SidebarRecentSession[] {
  return host.collapsedSessionSections.has("pinned")
    ? visibleRows
    : [
        ...sidebarPinnedSessionRows(zone, (key) =>
          host.sessionDataContext?.sessions.archiveVisibility(key),
        ),
        ...visibleRows,
      ];
}
