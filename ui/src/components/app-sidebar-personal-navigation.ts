import { lazyModule } from "solid-js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import {
  buildReconciledSidebarZone,
  findProjectedSidebarSession,
} from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import type { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  sidebarPinnedSessionRows,
  type SidebarRecentSession,
  type SidebarPinZone,
  type SidebarSavedPinTime,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";
import type { SessionOwnerFilter } from "./session-owner-filter.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export type PersonalNavigationHost = {
  readonly sessionData: SessionDataOwner;
  readonly sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sidebarPluginSnapshot: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
  readonly sidebarEntries: readonly string[];
  readonly sessionOwnerFilterId: string | null;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionsShowSystem: boolean;
  readonly gatewayTimeForSavedPin: SidebarSavedPinTime;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly sidebarAgentsMode: "chip" | "roster";
  expandedAgentId(): string;
  selectedAgentMainSessionKey(agentId?: string): string;
  readonly resolveSessionAttention: Parameters<typeof projectSessionTree>[0]["resolveAttention"];
  readonly sessionDataContext:
    | Pick<
        ApplicationContext,
        "agents" | "sessions" | "gateway" | "plugins" | "connectionBootstrap"
      >
    | undefined;
  sessionNavigationAgentId(row: Pick<GatewaySessionRow, "key" | "agentId">): string;
  getRouteSessionKey(): string;
  getSessionNavigationState(): SidebarSessionNavigationState;
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

const loadPins = lazyModule(() => import("./app-sidebar-pin-observations.ts"));

export function createSidebarPinnedSessions(
  host: PersonalNavigationHost & { readonly isConnected: boolean },
) {
  let owner:
    | ReturnType<Awaited<ReturnType<typeof loadPins>>["createSidebarPinRuntime"]>
    | undefined;
  let loading = false;
  let pendingSeed:
    | {
        rows: readonly SidebarRecentSession[];
        scope: NonNullable<ReturnType<ApplicationContext["sessions"]["captureConnectionScope"]>>;
      }
    | undefined;
  function getOwner() {
    if (owner) {
      return owner;
    }
    const mod = loadPins.peek();
    if (mod) {
      owner = mod.createSidebarPinRuntime(host);
      if (
        pendingSeed &&
        host.sessionDataContext?.sessions.isConnectionScopeCurrent(pendingSeed.scope)
      ) {
        owner.seed(pendingSeed.rows);
      }
      pendingSeed = undefined;
    } else if (!loading) {
      loading = true;
      void loadPins().then(
        () => {
          loading = false;
          if (host.isConnected) {
            host.sessionData.requestSessionDataUpdate();
          }
        },
        () => {
          loading = false;
        },
      );
    }
    return owner;
  }
  return {
    synchronize: () => owner?.synchronize(),
    dispose() {
      owner?.dispose();
      owner = undefined;
      pendingSeed = undefined;
    },
    seed(rows: readonly SidebarRecentSession[]) {
      if (!rows.length) {
        return;
      }
      const runtime = getOwner();
      if (runtime) {
        runtime.seed(rows);
      } else {
        const scope = host.sessionDataContext?.sessions.captureConnectionScope();
        if (scope) {
          pendingSeed = { rows, scope };
        }
      }
    },
    project(rows: SidebarRecentSession[], roster: SessionsListResult | null | undefined) {
      if (
        !host.sidebarEntries.some(
          (entry) => entry.startsWith("session:") || entry.startsWith("session-rail:"),
        )
      ) {
        return [];
      }
      const runtime = getOwner();
      if (runtime) {
        return runtime.projectPins(rows, roster);
      }
      const sessions = host.sessionDataContext?.sessions;
      const seeds =
        pendingSeed && sessions?.isConnectionScopeCurrent(pendingSeed.scope)
          ? pendingSeed.rows
          : [];
      const navigationState = host.getSessionNavigationState();
      // A listed Home pin is real metadata even though Home isn't an ordinary sidebar row.
      // Keep known links visible while loading the owner; only its scoped result adds children.
      return host.sidebarEntries.flatMap((value) => {
        const entry = parseSidebarEntry(value);
        if (entry?.type !== "session" || sessions?.deletionState(entry.key)) {
          return [];
        }
        if (
          rows.some((row) => row.key === entry.key) &&
          navigationState.routeOnlyRow?.key !== entry.key
        ) {
          return [];
        }
        const row =
          findProjectedSidebarSession({
            sessionKey: entry.key,
            navigationState,
            sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
            backingOnly: true,
          }) ?? seeds.find((seed) => seed.key === entry.key);
        if (!row) {
          return [];
        }
        return [
          host.sessionInvolvingMeFilterActive
            ? { ...row, children: [], childSessionKeys: [], childLoadParentKeys: [] }
            : row,
        ];
      });
    },
  };
}

export function personalSessionMatchesAgent(host: PersonalNavigationHost, key: string): boolean {
  return (
    host.sidebarAgentsMode === "roster" ||
    host.sessionNavigationAgentId({ key }) === host.expandedAgentId()
  );
}

export function personalSidebarZone(
  host: PersonalNavigationHost & {
    readonly pinnedSessions: ReturnType<typeof createSidebarPinnedSessions>;
  },
  rows: SidebarRecentSession[],
  rosterResult: SessionsListResult | null | undefined,
) {
  const pins = host.pinnedSessions.project(rows, rosterResult);
  const zone = buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...rows, ...pins],
    pluginNavigation: host.pluginNavigation(),
    pluginTabs: host.sessionDataContext?.gateway.snapshot.hello?.controlUiTabs,
    pendingPlugins:
      host.sessionDataContext?.plugins.registryStatus !== "complete"
        ? host.sidebarPluginSnapshot
        : null,
  });
  // Scope sidebar pins without removing saved references or global rail shortcuts.
  zone.entries = zone.entries.filter(
    (entry) =>
      entry.type !== "session" || entry.rail || personalSessionMatchesAgent(host, entry.key),
  );
  return zone;
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
    readonly sessionOwnerFilter: SessionOwnerFilter;
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
  const selectedOwnerId = host.sessionOwnerFilterId;
  return applySidebarSessionOwnerFilter({
    projected,
    ownerFacet,
    selectedOwnerId,
    selectedProfileId: selectedOwnerId === self?.id ? self.id : undefined,
    self,
  });
}

export function sidebarVisibleRowsInOrder(
  zone: SidebarPinZone,
  visibleRows: SidebarRecentSession[],
  host: {
    readonly collapsedSessionSections: ReadonlySet<string>;
    readonly gatewayPinTime?: number;
    readonly sessionDataContext?: {
      sessions: Pick<ApplicationContext["sessions"], "archiveVisibility">;
    };
  },
): SidebarRecentSession[] {
  const pins = host.collapsedSessionSections.has("pinned")
    ? []
    : sidebarPinnedSessionRows(
        zone,
        (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
        host.gatewayPinTime,
      );
  return [...pins, ...visibleRows];
}
