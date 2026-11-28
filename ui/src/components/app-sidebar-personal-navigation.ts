import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import {
  childSessionListQuery,
  fetchChildSessionRows,
} from "../lib/sessions/child-session-data.ts";
import type { SessionConnectionScope } from "../lib/sessions/session-capability.ts";
import { areUiSessionKeysEquivalent, isPinnableUiSessionRow } from "../lib/sessions/session-key.ts";
import {
  isPersistedSessionRow,
  readSessionChangedEvent,
} from "../lib/sessions/session-row-reconcile.ts";
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
  pluginNavigation(): Parameters<typeof buildReconciledSidebarZone>[0]["pluginNavigation"];
};

/** One reference per key; a sidebar pin wins over a rail-only shortcut. */
function savedSessionReferences(entries: readonly string[]): Map<string, boolean> {
  const pins = new Map<string, boolean>();
  for (const value of entries) {
    const entry = parseSidebarEntry(value);
    if (entry?.type === "session") {
      pins.set(entry.key, !entry.rail || pins.get(entry.key) === true);
    }
  }
  return pins;
}

function pinBackingRow(
  host: {
    getSessionNavigationState(): SidebarSessionNavigationState;
    sessionData: Pick<SessionDataOwner, "sessionResultsByAgent">;
  },
  key: string,
  navigationState = host.getSessionNavigationState(),
) {
  return findSidebarSessionRow({
    sessionKey: key,
    navigationState,
    sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
    backingOnly: true,
  });
}

/** Personal references observe the session owner; seeds only bridge presentation. */
export function createSidebarPinnedSessions(
  host: Pick<
    PersonalNavigationHost,
    | "sessionDataContext"
    | "getSessionNavigationState"
    | "sidebarEntries"
    | "sessionNavigationAgentId"
    | "getRouteSessionKey"
    | "sessionInvolvingMeFilterActive"
  > & {
    readonly isConnected: boolean;
    readonly sessionData: Pick<
      SessionDataOwner,
      "requestSessionDataUpdate" | "sessionResultsByAgent"
    >;
  },
) {
  let source: ApplicationContext["sessions"] | undefined;
  let scope: SessionConnectionScope | null = null;
  type Read = {
    observation?: ReturnType<ApplicationContext["sessions"]["observeRow"]>;
    settled: boolean;
  };
  const reads = new Map<string, Read | "invalidated">();
  type ChildRead = { observation?: ReturnType<ApplicationContext["sessions"]["observeList"]> };
  const childReads = new Map<string, ChildRead>();
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
    for (const read of childReads.values()) {
      read.observation?.dispose();
    }
    childReads.clear();
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
    const pins = savedSessionReferences(host.sidebarEntries);
    for (const key of reads.keys()) {
      if (!pins.has(key)) {
        retire(key);
      }
    }
    for (const key of seeds.keys()) {
      if (!pins.has(key)) {
        seeds.delete(key);
      }
    }
    for (const [key, read] of childReads) {
      if (!host.sessionInvolvingMeFilterActive || !pins.get(key)) {
        read.observation?.dispose();
        childReads.delete(key);
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
        if (!host.isConnected || pinBackingRow(host, key)) {
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
    if (row) {
      return project(row);
    }
    const retained = read.settled ? undefined : seeds.get(key)?.();
    // The seed can come from a different owner filter or the boot snapshot.
    return retained && host.sessionInvolvingMeFilterActive
      ? { ...retained, children: [], childSessionKeys: [], childLoadParentKeys: [] }
      : retained;
  }

  function involvedChildren(
    parent: GatewaySessionRow,
    result: SessionsListResult | null,
  ): readonly GatewaySessionRow[] {
    const context = host.sessionDataContext;
    const sessions = synchronizeSource();
    const connection = scope;
    if (!host.isConnected || !context || !sessions || !connection) {
      return [];
    }
    const parentKey = parent.key;
    const query = { ...childSessionListQuery(parentKey), involvingMe: true } as const;
    const existing = childReads.get(parentKey);
    if (existing) {
      return existing.observation ? (sessions.listSnapshot(query).result?.sessions ?? []) : [];
    }
    const knownChildren = parent.childSessions ?? [];
    // Route-only placeholders can be missing links even when the parent has children.
    if (
      (knownChildren.length > 0 || isPersistedSessionRow(parent)) &&
      knownChildren.every((key) => result?.sessions.some((row) => row.key === key))
    ) {
      return [];
    }
    const read: ChildRead = {};
    childReads.set(parentKey, read);
    const isCurrent = () =>
      host.isConnected &&
      host.sessionInvolvingMeFilterActive &&
      host.sessionDataContext === context &&
      sessions.isConnectionScopeCurrent(connection) &&
      childReads.get(parentKey) === read;
    void context.connectionBootstrap.run(
      read,
      async () => {
        await Promise.resolve(); // A held observation can publish synchronously.
        if (!isCurrent()) {
          return;
        }
        let paging = false;
        read.observation = sessions.observeList(query, (snapshot) => {
          if (!isCurrent() || snapshot.loading) {
            return;
          }
          host.sessionData.requestSessionDataUpdate();
          if (snapshot.result && snapshot.pagination?.hasMore && !paging) {
            paging = true;
            void fetchChildSessionRows({
              sessions,
              parentKey,
              involvingMe: true,
              isCurrent,
              initialResult: snapshot.result,
            })
              .catch(() => undefined)
              .finally(() => {
                paging = false;
              });
          }
        });
        await read.observation.refresh().catch(() => undefined);
      },
      { background: true },
    );
    return [];
  }
  return { synchronize, seed, get, involvedChildren, dispose };
}

function resolvePinnedSession(
  host: PersonalNavigationHost,
  key: string,
  navigationState: SidebarSessionNavigationState,
  sidebarPin: boolean,
  rosterResult: SessionsListResult | null | undefined,
) {
  const involvingMe = host.sessionInvolvingMeFilterActive;
  const scopedResultFor = (agentId: string) =>
    rosterResult === undefined ? host.sessionData.resultForAgent(agentId) : rosterResult;
  const project = (row: GatewaySessionRow) => {
    const agentId = host.sessionNavigationAgentId(row);
    if (
      !isPinnableUiSessionRow(row) ||
      areUiSessionKeysEquivalent(key, host.selectedAgentMainSessionKey(agentId))
    ) {
      return navigationState.toSidebarSession(involvingMe ? { ...row, childSessions: [] } : row);
    }
    // Root metadata can come from a descriptor; only scoped lists own child membership.
    const result = scopedResultFor(agentId);
    const { session } = projectSidebarSessionReference({
      host,
      row,
      agentId,
      navigationState,
      resolveAttention: host.resolveSessionAttention,
      involvingMe,
      result,
      involvedChildren:
        sidebarPin && involvingMe && row.archived !== true && personalSessionMatchesAgent(host, key)
          ? host.pinnedSessions.involvedChildren(row, result)
          : undefined,
    });
    return filterPinnedSessionChildrenByOwner(session, host.sessionOwnerFilterId);
  };
  const resolved =
    (involvingMe
      ? scopedResultFor(host.sessionNavigationAgentId({ key }))?.sessions.find(
          (candidate) => candidate.key === key,
        )
      : undefined) ?? pinBackingRow(host, key, navigationState);
  return resolved ? project(resolved) : host.pinnedSessions.get(key, project);
}

function personalSessionMatchesAgent(host: PersonalNavigationHost, key: string): boolean {
  return (
    host.sidebarAgentsMode === "roster" ||
    host.sessionNavigationAgentId({ key }) === host.expandedAgentId()
  );
}

export function personalSidebarZone(
  host: PersonalNavigationHost,
  rows: SidebarRecentSession[],
  rosterResult: SessionsListResult | null | undefined,
) {
  let navigationState: SidebarSessionNavigationState | undefined;
  const canonical = new Map(rows.map((row) => [row.key, row]));
  const pins = [...savedSessionReferences(host.sidebarEntries)].flatMap(([key, sidebarPin]) => {
    // Query replacement may retain a descriptor; a known deletion may not.
    if (host.sessionDataContext?.sessions.deletionState(key)) {
      return [];
    }
    navigationState ??= host.getSessionNavigationState();
    const projected =
      host.sessionInvolvingMeFilterActive || navigationState.routeOnlyRow?.key === key
        ? undefined
        : canonical.get(key);
    const row =
      projected ?? resolvePinnedSession(host, key, navigationState, sidebarPin, rosterResult);
    return row ? [row] : [];
  });
  if (pins.length) {
    // Visible references bridge query replacement until their owner observations settle.
    host.pinnedSessions.seed(pins);
  }
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
