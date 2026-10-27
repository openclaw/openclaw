import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry, type NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { PersonalSessionGroup } from "../lib/sessions/personal-groups.ts";
import type {
  SessionConnectionScope,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";
import { readSessionChangedEvent } from "../lib/sessions/session-row-reconcile.ts";
import { showToast } from "../lib/toast.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import { projectSidebarSessionReference } from "./app-sidebar-agent-session-rows.ts";
import {
  buildReconciledSidebarZone,
  findSidebarSessionRow,
} from "./app-sidebar-session-navigation-logic.ts";
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

type PersonalNavigationHost = Parameters<typeof projectSidebarSessionReference>[0]["host"] & {
  readonly pinnedSessions: ReturnType<typeof createSidebarPinnedSessions>;
  readonly sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
  readonly sidebarEntries: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  readonly sessionDataContext:
    | Pick<
        ApplicationContext,
        "sessions" | "gateway" | "plugins" | "connectionBootstrap" | "navigation"
      >
    | undefined;
  readonly navigationCatalog: { readonly dashboards: SessionListSnapshot | null };
  readonly resolveSessionAttention: Parameters<
    typeof projectSidebarSessionReference
  >[0]["resolveAttention"];
  sessionNavigationAgentId(row: Pick<GatewaySessionRow, "key" | "agentId">): string;
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  findSidebarSessionByKey(
    key: string,
    navigationState?: SidebarSessionNavigationState,
  ): SidebarRecentSession | undefined;
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

/** Personal references observe the session owner; seeds only bridge presentation. */
export function createSidebarPinnedSessions(
  host: Pick<
    PersonalNavigationHost,
    | "sessionDataContext"
    | "findSidebarSessionByKey"
    | "navigationCatalog"
    | "sidebarEntries"
    | "sessionNavigationAgentId"
    | "getSessionNavigationState"
    | "getRouteSessionKey"
  > & {
    readonly isConnected: boolean;
    readonly sessionData: Pick<SessionDataOwner, "requestSessionDataUpdate">;
  },
) {
  let source: ApplicationContext["sessions"] | undefined;
  let scope: SessionConnectionScope | null = null;
  type Read = {
    observation?: ReturnType<ApplicationContext["sessions"]["observeRow"]>;
    settled: boolean;
  };
  const reads = new Map<string, Read | "invalidated">();
  const seeds = new Map<string, () => SidebarRecentSession>();
  function retire(key: string) {
    const read = reads.get(key);
    if (read && read !== "invalidated") {
      read.observation?.dispose();
    }
    reads.delete(key);
    seeds.delete(key);
  }
  function dispose() {
    for (const key of reads.keys()) {
      retire(key);
    }
    seeds.clear();
    source = undefined;
    scope = null;
  }
  function synchronizeSource() {
    const nextSource = host.sessionDataContext?.sessions;
    if (nextSource !== source || !scope || !nextSource?.isConnectionScopeCurrent(scope)) {
      dispose();
      source = nextSource;
      scope = source?.captureConnectionScope() ?? null;
    }
    return source;
  }
  function synchronize() {
    synchronizeSource();
    const keys = new Set(
      host.sidebarEntries.flatMap((value) => {
        const entry = parseSidebarEntry(value);
        return entry?.type === "session" ? [entry.key] : [];
      }),
    );
    for (const group of host.sessionDataContext?.navigation.snapshot.personalSessionGroups ?? []) {
      for (const key of group.sessionKeys) {
        keys.add(key);
      }
    }
    for (const key of reads.keys()) {
      if (!keys.has(key)) {
        retire(key);
      }
    }
    for (const key of seeds.keys()) {
      if (!keys.has(key)) {
        seeds.delete(key);
      }
    }
    return source;
  }
  function seed(snapshot: readonly SidebarRecentSession[]): void {
    synchronizeSource();
    if (!scope) {
      return;
    }
    for (const row of snapshot) {
      const read = reads.get(row.key);
      if (!seeds.has(row.key) && (read === "invalidated" || !read?.settled)) {
        seeds.set(row.key, () => ({
          ...row,
          active: row.key === host.getRouteSessionKey(),
          visuallyActive: row.key === host.getRouteSessionKey(),
        }));
      }
    }
  }
  function readReference(key: string): Read | undefined {
    const context = host.sessionDataContext;
    const currentSource = synchronizeSource();
    const currentScope = scope;
    if (!host.isConnected || !currentSource || !currentScope || !context) {
      return undefined;
    }
    let read = reads.get(key);
    if (!read || read === "invalidated") {
      const refresh = read === "invalidated";
      const owned: Read = { settled: false };
      read = owned;
      reads.set(key, owned);
      const current = () =>
        reads.get(key) === owned &&
        source === currentSource &&
        host.sessionDataContext === context &&
        scope === currentScope &&
        currentSource.isConnectionScopeCurrent(currentScope);
      const publish = () => {
        if (!current()) {
          return;
        }
        if (owned.observation?.isCurrent() === false) {
          invalidate();
        } else if (host.isConnected) {
          host.sessionData.requestSessionDataUpdate();
        }
      };
      const invalidate = () => {
        if (!current()) {
          return;
        }
        retire(key);
        reads.set(key, "invalidated");
        if (host.isConnected) {
          host.sessionData.requestSessionDataUpdate();
        }
      };
      const describe = async () => {
        // Register outside the render read phase: a held row can publish immediately.
        await Promise.resolve();
        if (!current()) {
          return;
        }
        if (
          !host.isConnected ||
          host.findSidebarSessionByKey(key) ||
          host.navigationCatalog.dashboards?.result?.sessions.some((row) => row.key === key)
        ) {
          if (refresh) {
            reads.set(key, "invalidated");
          } else {
            reads.delete(key);
          }
          return;
        }
        const observation = currentSource.observeRow(
          { key, agentId: host.sessionNavigationAgentId({ key }) },
          publish,
          {
            onInvalidate: invalidate,
            onEvent: (event, result) => {
              if (
                !result.generationRejected &&
                event.event === "sessions.changed" &&
                !readSessionChangedEvent(event.payload)
              ) {
                invalidate();
              }
            },
          },
        );
        owned.observation = observation;
        const reconcile = observation.captureReconcile();
        const accept = (row?: GatewaySessionRow | null) => {
          if (!current()) {
            return;
          }
          owned.settled = true;
          seeds.delete(key);
          reconcile(row ?? undefined);
          publish();
        };
        // A supplemental read can retire the row without clearing its old descriptor.
        const description = refresh
          ? currentSource.describe({ key }, { refresh: true })
          : currentSource.describe({ key });
        await description.then(
          (result) => accept(result.session),
          () => accept(),
        );
      };
      void context.connectionBootstrap.run(describe, describe, { background: true });
    }
    return read;
  }
  function getRow(key: string): GatewaySessionRow | undefined {
    return readReference(key)?.observation?.row ?? undefined;
  }
  function get(key: string): SidebarRecentSession | undefined {
    const read = readReference(key);
    if (!read) {
      return undefined;
    }
    const row = read.observation?.row;
    return row
      ? host.getSessionNavigationState().toSidebarSession(row)
      : read.settled
        ? undefined
        : seeds.get(key)?.();
  }
  return { synchronize, seed, get, getRow, dispose };
}

/** Saved group membership is a reference, never authority to reveal a session. */
function readPersonalSidebarSession(
  host: PersonalNavigationHost,
  key: string,
  navigationState: SidebarSessionNavigationState,
) {
  const live =
    findSidebarSessionRow({
      sessionKey: key,
      navigationState,
      sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
    }) ?? host.navigationCatalog.dashboards?.result?.sessions.find((row) => row.key === key);
  return live ?? host.pinnedSessions.getRow(key);
}

/** Stable owner rows invalidate group-tree lifecycle without changing roster membership. */
export function personalGroupSessionReferences(host: PersonalNavigationHost) {
  if (host.sidebarSnapshot) {
    return [];
  }
  const keys = new Set(
    (host.sessionDataContext?.navigation.snapshot.personalSessionGroups ?? []).flatMap(
      (group) => group.sessionKeys,
    ),
  );
  const navigationState = host.getSessionNavigationState();
  return [...keys].map((key) => readPersonalSidebarSession(host, key, navigationState));
}

function resolvePersonalSidebarSession(
  host: PersonalNavigationHost,
  key: string,
  navigationState: SidebarSessionNavigationState,
  projectChildren: boolean,
) {
  const row = readPersonalSidebarSession(host, key, navigationState);
  if (row && !projectChildren) {
    return navigationState.toSidebarSession(row);
  }
  return row
    ? projectSidebarSessionReference({
        host,
        row,
        agentId: host.sessionNavigationAgentId(row),
        navigationState,
        resolveAttention: host.resolveSessionAttention,
      }).session
    : host.pinnedSessions.get(key);
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  let navigationState: SidebarSessionNavigationState | undefined;
  const groupKeys = new Set(
    (host.sessionDataContext?.navigation.snapshot.personalSessionGroups ?? []).flatMap(
      (group) => group.sessionKeys,
    ),
  );
  const keys = host.sidebarSnapshot
    ? []
    : [
        ...host.sidebarEntries.flatMap((value) => {
          const entry = parseSidebarEntry(value);
          return entry?.type === "session" ? [entry.key] : [];
        }),
        ...groupKeys,
      ];
  const canonical = new Map(rows.map((row) => [row.key, row]));
  const pins = [...new Set(keys)].flatMap((key) => {
    const projected = canonical.get(key);
    const row =
      projected ??
      resolvePersonalSidebarSession(
        host,
        key,
        (navigationState ??= host.getSessionNavigationState()),
        groupKeys.has(key),
      );
    return row ? [row] : [];
  });
  if (pins.length) {
    // Visible references bridge query replacement until their owner observations settle.
    host.pinnedSessions.seed(pins);
  }
  return buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...pins, ...rows],
    pluginNavigation: host.pluginNavigation(),
    pluginTabs: host.sessionDataContext?.gateway.snapshot.hello?.controlUiTabs,
    pendingPlugins:
      host.sessionDataContext?.plugins.registryStatus !== "complete"
        ? host.sidebarPluginSnapshot
        : null,
  });
}

/** Group occurrences share the canonical tree and its child observation metadata. */
export function personalSidebarGroupRows(
  host: PersonalNavigationHost & { reconciledSidebarZone(): SidebarPinZone },
  group: PersonalSessionGroup,
  zone?: SidebarPinZone,
): SidebarRecentSession[] {
  if (host.sidebarSnapshot) {
    return [];
  }
  const rows = (zone ?? host.reconciledSidebarZone()).sessionRows;
  return group.sessionKeys.flatMap((key) => {
    const row = rows.get(key);
    return row?.pinnable &&
      !row.archived &&
      !host.sessionDataContext?.sessions.archiveVisibility(key)
      ? [{ ...row, selectionKey: `personal:${JSON.stringify([group.id, key])}` }]
      : [];
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

/** Rendering and selection share archive visibility for personal references. */
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
  personalGroupRows: readonly SidebarRecentSession[] = [],
): SidebarRecentSession[] {
  const pins = host.collapsedSessionSections.has("pinned")
    ? []
    : sidebarPinnedSessionRows(zone, (key) =>
        host.sessionDataContext?.sessions.archiveVisibility(key),
      );
  // Keep appearances until the clicked range is resolved; batch targets deduplicate later.
  return [...personalGroupRows, ...pins, ...visibleRows];
}
