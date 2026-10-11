import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type {
  SessionConnectionScope,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { buildReconciledSidebarZone } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import {
  setStoredSessionCatalogHidden,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import type { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type PersonalNavigationHost = {
  readonly pinnedSessions: SidebarPinnedSessions;
  readonly sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
  readonly sidebarEntries: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  readonly sessionDataContext:
    | Pick<ApplicationContext, "sessions" | "gateway" | "plugins">
    | undefined;
  readonly navigationCatalog: { readonly dashboards: SessionListSnapshot | null };
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  findSidebarSessionByKey(key: string): SidebarRecentSession | undefined;
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

export function hidePersonalSidebarCatalog(
  host: Pick<AppSidebarRenderHost, "sessionData" | "basePath" | "ownerDocument" | "onNavigate">,
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
  recoveryLink.addEventListener("click", (event) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    event.preventDefault();
    host.onNavigate?.(recovery.routeId, { search: recovery.search, hash: recovery.hash });
  });
  message.append(t("chat.sidebar.sectionHidden", { section: label }), " ", recoveryLink);
  showToast({
    message,
    actionLabel: t("common.undo"),
    onAction: () => setStoredSessionCatalogHidden(catalogId, false),
    durationMs: 12_000,
  });
}

/** Descriptor snapshots last one connection; loaded rows always supersede them. */
export class SidebarPinnedSessions implements ReactiveController {
  private source?: ApplicationContext["sessions"];
  private scope: SessionConnectionScope | null = null;
  private readonly requested = new Set<string>();
  private readonly rows = new Map<string, GatewaySessionRow>();

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly isConnected: boolean;
      readonly sessionDataContext: PersonalNavigationHost["sessionDataContext"];
    },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.host.requestUpdate();
  }

  hostUpdate(): void {
    if (
      this.scope &&
      (!this.source?.isConnectionScopeCurrent(this.scope) ||
        this.source !== this.host.sessionDataContext?.sessions)
    ) {
      this.clear();
    }
  }

  get(key: string): GatewaySessionRow | undefined {
    const source = this.host.sessionDataContext?.sessions;
    if (source !== this.source || !this.scope || !source?.isConnectionScopeCurrent(this.scope)) {
      this.clear();
      this.source = source;
      this.scope = source?.captureConnectionScope() ?? null;
    }
    const scope = this.scope;
    if (!this.host.isConnected || !source || !scope) {
      return undefined;
    }
    if (!this.requested.has(key)) {
      this.requested.add(key);
      void source.describe({ key }).then(
        (result) => {
          if (
            result.session &&
            this.source === source &&
            this.host.sessionDataContext?.sessions === source &&
            this.scope === scope &&
            source.isConnectionScopeCurrent(scope)
          ) {
            // A title/icon may be stale until the row loads or the connection changes.
            this.rows.set(key, result.session);
            if (this.host.isConnected) {
              this.host.requestUpdate();
            }
          }
        },
        () => {
          /* Missing or failed pins stay saved, invisible, and silent. */
        },
      );
    }
    return this.rows.get(key);
  }

  private clear(): void {
    this.source = undefined;
    this.scope = null;
    this.requested.clear();
    this.rows.clear();
  }
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  const pins = host.sidebarEntries.flatMap((value) => {
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
    readonly sessionOwnerFilter: SessionOwnerFilterController;
    expandedAgentId(): string;
  },
): string | null {
  if (host.sidebarSnapshot) {
    return host.sidebarSnapshot.ownerId;
  }
  const agentId = host.sidebarAgentsMode === "roster" ? "*" : host.expandedAgentId();
  const hasMultipleOwners = host.sessionOwnerFilter.hasMultipleOwners(agentId);
  const ownerId = host.sessionOwnerFilter.ownerId;
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
