import type { SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry, serializeSidebarEntry } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
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
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type PersonalNavigationHost = {
  readonly isConnected: boolean;
  personalNavigationEpoch: number;
  readonly activeRouteId?: string;
  readonly navigationView: string;
  readonly effectiveNavigationScope: "mine" | "all";
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
  selectSession(key: string, agentId?: string, row?: SidebarRecentSession): void;
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

export async function openPersonalPinnedSession(
  host: PersonalNavigationHost,
  sessionKey: string,
): Promise<void> {
  const epoch = ++host.personalNavigationEpoch;
  const route = host.activeRouteId;
  const view = host.navigationView;
  const selected = host.getRouteSessionKey();
  const sessions = host.sessionDataContext?.sessions;
  const scope = sessions?.captureConnectionScope();
  if (!sessions || !scope) {
    return;
  }
  const isCurrent = () =>
    host.isConnected &&
    host.personalNavigationEpoch === epoch &&
    host.activeRouteId === route &&
    host.navigationView === view &&
    host.getRouteSessionKey() === selected &&
    sessions === host.sessionDataContext?.sessions &&
    sessions.isConnectionScopeCurrent(scope) &&
    host.sidebarEntries.includes(serializeSidebarEntry({ type: "session", key: sessionKey }));
  try {
    const result = await sessions.describe({ key: sessionKey });
    if (!isCurrent()) {
      return;
    }
    if (!result.session) {
      showToast({ message: t("chat.sessionRoute.notFoundTitle") });
      return;
    }
    host.selectSession(
      sessionKey,
      undefined,
      host.getSessionNavigationState().toSidebarSession(result.session),
    );
  } catch {
    if (isCurrent()) {
      showToast({ message: t("sessionsView.openFailed") });
    }
  }
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  const pins = host.sidebarEntries.flatMap((value) => {
    const entry = parseSidebarEntry(value);
    const catalogRow =
      entry?.type === "session"
        ? host.navigationCatalog.dashboards?.result?.sessions.find((row) => row.key === entry.key)
        : undefined;
    const row = catalogRow
      ? host.getSessionNavigationState().toSidebarSession(catalogRow)
      : entry?.type === "session"
        ? host.findSidebarSessionByKey(entry.key)
        : undefined;
    return row ? [row] : [];
  });
  return buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...rows, ...pins],
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

export function personalSidebarOwnerProjection(
  host: PersonalNavigationHost,
  projected: SidebarRecentSession[],
  ownerFacet: SessionsListResult["owners"],
) {
  const context = host.sessionDataContext;
  const self = context?.gateway.snapshot.selfUser;
  const presentation = context?.sessions.presentation;
  const profileId =
    self?.id ??
    (context?.gateway.snapshot.phase !== "connected"
      ? (presentation?.profileId ?? undefined)
      : undefined);
  const result = applySidebarSessionOwnerFilter({
    projected,
    ownerFacet,
    selectedOwnerId:
      host.effectiveNavigationScope === "mine" ? (profileId ?? null) : host.sessionOwnerFilterId,
    selectedProfileId: host.effectiveNavigationScope === "mine" ? profileId : undefined,
    self,
  });
  // Retained rows use their admitted profile, not unresolved live identity or another account.
  return host.effectiveNavigationScope === "mine" && !profileId ? { ...result, rows: [] } : result;
}
