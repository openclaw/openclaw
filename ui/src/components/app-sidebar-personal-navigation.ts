import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { SessionConnectionScope } from "../lib/sessions/session-capability.ts";
import { areUiSessionKeysEquivalent, isPinnableUiSessionRow } from "../lib/sessions/session-key.ts";
import { readSessionChangedEvent } from "../lib/sessions/session-row-reconcile.ts";
import { projectSidebarSessionReference } from "./app-sidebar-agent-session-rows.ts";
import {
  buildReconciledSidebarZone,
  findSidebarSessionRow,
} from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import {
  applySidebarSessionOwnerFilter,
  filterPinnedSessionChildrenByOwner,
} from "./app-sidebar-session-ownership.ts";
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

type PersonalNavigationHost = {
  readonly sessionData: SessionDataOwner;
  readonly pinnedSessions: ReturnType<typeof createSidebarPinnedSessions>;
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
  findSidebarSessionByKey(
    key: string,
    navigationState?: SidebarSessionNavigationState,
  ): SidebarRecentSession | undefined;
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

/** Personal references observe the session owner; seeds only bridge presentation. */
export function createSidebarPinnedSessions(
  host: Pick<
    PersonalNavigationHost,
    | "sessionDataContext"
    | "findSidebarSessionByKey"
    | "sidebarEntries"
    | "sessionNavigationAgentId"
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
  function retire(key: string, keepSeed = false) {
    const read = reads.get(key);
    if (read && read !== "invalidated") {
      read.observation?.dispose();
    }
    reads.delete(key);
    if (!keepSeed) {
      seeds.delete(key);
    }
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
      // Keep the latest visible projection for an observed row, so a refresh can
      // retain it without projecting again inside an event handler.
      if (!seeds.has(row.key) || (read !== "invalidated" && read?.observation?.row)) {
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
        retire(key, Boolean(owned.observation?.row));
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
        if (!host.isConnected || host.findSidebarSessionByKey(key)) {
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
          if (!row) {
            seeds.delete(key);
          }
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
  function get(
    key: string,
    project: (row: GatewaySessionRow) => SidebarRecentSession,
  ): SidebarRecentSession | undefined {
    const read = readReference(key);
    if (!read) {
      return undefined;
    }
    const row = read.observation?.row;
    return row ? project(row) : read.settled ? undefined : seeds.get(key)?.();
  }
  return { synchronize, seed, get, dispose };
}

function resolvePinnedSession(
  host: PersonalNavigationHost,
  key: string,
  navigationState: SidebarSessionNavigationState,
) {
  const project = (row: GatewaySessionRow) => {
    const agentId = host.sessionNavigationAgentId(row);
    if (
      !isPinnableUiSessionRow(row) ||
      areUiSessionKeysEquivalent(key, host.selectedAgentMainSessionKey(agentId))
    ) {
      return navigationState.toSidebarSession(row);
    }
    const { session } = projectSidebarSessionReference({
      host,
      row,
      agentId,
      navigationState,
      resolveAttention: host.resolveSessionAttention,
      involvingMe: host.sessionInvolvingMeFilterActive,
    });
    return filterPinnedSessionChildrenByOwner(session, host.sessionOwnerFilterId);
  };
  const row = findSidebarSessionRow({
    sessionKey: key,
    navigationState,
    sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
  });
  return row ? project(row) : host.pinnedSessions.get(key, project);
}

function personalSessionMatchesAgent(host: PersonalNavigationHost, key: string): boolean {
  return (
    host.sidebarAgentsMode === "roster" ||
    host.sessionNavigationAgentId({ key }) === host.expandedAgentId()
  );
}

export function personalSidebarZone(host: PersonalNavigationHost, rows: SidebarRecentSession[]) {
  let navigationState: SidebarSessionNavigationState | undefined;
  const keys = host.sidebarSnapshot
    ? []
    : host.sidebarEntries.flatMap((value) => {
        const entry = parseSidebarEntry(value);
        return entry?.type === "session" ? [entry.key] : [];
      });
  const canonical = new Map(rows.map((row) => [row.key, row]));
  const pins = [...new Set(keys)].flatMap((key) => {
    // Query replacement may retain a descriptor; a known deletion may not.
    if (host.sessionDataContext?.sessions.deletionState(key)) {
      return [];
    }
    const projected = canonical.get(key);
    const row =
      projected ??
      resolvePinnedSession(host, key, (navigationState ??= host.getSessionNavigationState()));
    return row ? [row] : [];
  });
  if (pins.length) {
    // Visible references bridge query replacement until their owner observations settle.
    host.pinnedSessions.seed(pins);
  }
  const zone = buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...pins, ...rows],
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
