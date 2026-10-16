import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { SidebarZoneEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import {
  groupSidebarSessionRows,
  type SidebarSessionSection,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { SidebarChildExpansion } from "./app-sidebar-child-expansion.ts";
import { sidebarPresencePresentation, type SidebarPresenceScope } from "./app-sidebar-presence.ts";
import {
  catalogErrorMessages,
  catalogSessionActivity,
  catalogSessionRowsByKey,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  visibleSessionChildren,
  type SidebarEmptyGroupsMode,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import {
  areSessionCatalogsSettled,
  type SessionDataControllerHost,
} from "./session-data-controller-catalog.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";
import { summarizeTeamSessionSlots } from "./solid/session-presentation.tsx";

const SIDEBAR_CREATED_ORDER_CAP = 1_000;
// Ambient subtitle sources (observer digest, narration, work path) race at
// event rate; without a floor the line swaps A->B->A within a second. Matches
// the narration throttle so replacement cadence stays consistent.
const SIDEBAR_SUBTITLE_MIN_DISPLAY_MS = 2_000;

type SidebarSubtitleParams = Parameters<typeof resolveSidebarSessionSubtitle>[0];
type SidebarSubtitleValue = ReturnType<typeof resolveSidebarSessionSubtitle>;

type SidebarProjectionInput = {
  rows: SidebarRecentSession[];
  sections?: SidebarSessionSection<SidebarRecentSession>[];
  grouping: SidebarSessionsGrouping;
  knownGroups: string[] | undefined;
  selfOwnerId?: string | null;
  catalogIds?: readonly string[];
  sectionOrder?: readonly string[];
  collapsedSections: ReadonlySet<string>;
  emptyGroupsMode: SidebarEmptyGroupsMode;
  ownerFiltered: boolean;
  visibleSessionLimits: ReadonlyMap<string, number>;
  sortMode: SidebarSessionSortMode;
  statusFilter: SidebarSessionStatusFilter;
  agentId: string;
  connectionIdentity: object | null;
  listSource: object | null;
  /** False while rows are only route placeholders, before the session list arrives. */
  listLoaded: boolean;
  subtitle: {
    sidebarLiveActivity: boolean;
    showPreview: boolean;
    narrationLines: ReadonlyMap<string, string>;
    observerDigests: ReadonlyMap<string, SessionObserverDigest>;
  };
};

export type SidebarVisibleSections = {
  sections: (SidebarSessionSection<SidebarRecentSession> & {
    totalRowCount: number;
    visibleRowCount: number;
    visibleLimit: number;
    collapsedVisibleRowCount: number;
    renderHeader: boolean;
  })[];
  visibleRows: SidebarRecentSession[];
};

type SidebarPresentationHost = Pick<
  SessionDataControllerHost,
  | "connected"
  | "navigationView"
  | "contextualSidebar"
  | "sidebarAgentsMode"
  | "sessionCatalogRowsVisible"
  | "sessionDataContext"
  | "expandedAgentId"
> & {
  readonly sessionData: SessionDataController;
  readonly sessionOwnershipVisibility: { filters: boolean; avatars: boolean };
  readonly sidebarMenus: { agentMenuPosition: { x: number; top: number } | null };
  readonly rosterSessionSource: {
    agentIds: readonly string[];
    collapsedAgentIds: ReadonlySet<string>;
  } | null;
  activeChipAgent(): {
    agents: readonly { id: string }[];
    identity: ReturnType<ApplicationContext["agentIdentity"]["get"]>;
    identities: ReadonlyMap<string, ReturnType<ApplicationContext["agentIdentity"]["get"]>>;
  };
  pluginNavigation(): readonly ControlUiRegistration<ControlUiNavigationItem>[];
  getSessionNavigationState(): { toSidebarSession(row: GatewaySessionRow): SidebarRecentSession };
  mainSessionRow(agentId: string): GatewaySessionRow | null;
  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarRecentSession;
  sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string;
  agentUnreadCount(agentId: string): number;
  otherAgentsHaveUnread(): boolean;
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  isSessionChildrenFullyShown(key: string): boolean;
  querySelectorAll: HTMLElement["querySelectorAll"];
};
type SidebarPresentationReaders = {
  snapshot: boolean;
  sections(): SidebarVisibleSections["sections"];
  tree(): SidebarRecentSession[];
  catalogs(): SidebarSessionCatalog[];
  catalogRows(): GatewaySessionRow[];
  ownerOptions(): readonly SessionOwnerOption[];
};

/** Attention, agent-declared status, and the queued explanation are messages
 * the operator must act on; they replace a held subtitle immediately. */
function isOperatorCriticalSubtitle(session: SidebarRecentSession): boolean {
  return Boolean(
    sessionAttentionSubtitle(session.attention) ||
    session.agentStatusNote ||
    (session.hasActiveRun && session.status === "queued"),
  );
}

export class SidebarSessionProjection {
  constructor(private readonly now: () => number = () => Date.now()) {}

  // Record frame admission only; owner.updated can precede child DOM bindings.
  private publishedSessionPresentation = "";
  private admittedPresencePresentation = "";

  shouldPublishSessionData(
    host: SidebarPresentationHost,
    readers: SidebarPresentationReaders,
  ): boolean {
    if (readers.snapshot) {
      return true;
    }
    const data = host.sessionData;
    const sessionsVisible = host.navigationView === "sessions" && !host.contextualSidebar;
    const chip = host.activeChipAgent();
    const replacement =
      sessionsVisible && host.sessionDataContext?.plugins.selectedReplacement("session-list");
    const navigation = host.getSessionNavigationState();
    const sections = sessionsVisible ? readers.sections() : [];
    const roster =
      sessionsVisible && host.sidebarAgentsMode === "roster" ? host.rosterSessionSource : null;
    const rosterSnapshot =
      sessionsVisible && host.sidebarAgentsMode === "roster" && host.sessionDataContext
        ? rosterActivityStore(host.sessionDataContext).snapshot
        : null;
    const catalogs = host.sessionCatalogRowsVisible ? readers.catalogs() : null;
    const catalogRowsByKey = catalogSessionRowsByKey(catalogs?.length ? readers.catalogRows() : []);
    const presentation = JSON.stringify([
      host.navigationView,
      host.connected,
      host.sessionDataContext?.gateway.snapshot.hello,
      host.sessionDataContext?.agents.state.agentsList,
      host.sidebarAgentsMode === "chip" ? chip.identity : null,
      host.sidebarAgentsMode === "chip" && host.otherAgentsHaveUnread(),
      host.sidebarMenus.agentMenuPosition !== null
        ? chip.agents.map(({ id }) => [
            chip.identities.get(normalizeAgentId(id)),
            host.agentUnreadCount(id),
          ])
        : null,
      host.sessionDataContext?.plugins.registryStatus,
      host.pluginNavigation().map(({ key, value }) => [key, value]),
      Boolean(replacement),
      replacement ? host.sessionDataContext?.sessions.state.result?.sessions : null,
      host.sessionDataContext?.sessions.groupsStatus(),
      host.sessionDataContext?.sessions.state.error,
      host.sessionDataContext?.sessions.eventSubscriptionError,
      host.sessionDataContext?.sessions.state.groupSettings,
      rosterSnapshot && [
        rosterSnapshot.cards.map(({ id, name, avatar, textAvatar }) => [
          id,
          name,
          avatar,
          textAvatar,
        ]),
        rosterSnapshot.loading,
        rosterSnapshot.error,
        rosterSnapshot.subscriptionError,
      ],
      readers.ownerOptions(),
      host.sessionOwnershipVisibility,
      data.sessionsLoading,
      data.sessionsStartupPending,
      data.sessionsResult?.hasMore,
      data.sessionMutationError,
      data.sessionCatalogRefreshStatus,
      [...data.loadingMoreSessionCatalogIds],
      [...data.childSessionErrorsByParent],
      catalogs
        ? [
            catalogs.map(({ hosts, ...visible }) => [
              visible,
              catalogErrorMessages({ ...visible, hosts }),
              hosts.some(({ nextCursor }) => Boolean(nextCursor)),
            ]),
            catalogs.map((catalog) =>
              catalogSessionActivity(
                catalog.visibleHosts.flatMap((catalogHost) => catalogHost.sessions),
                catalogRowsByKey,
                (row) => host.sessionDataContext?.sessions.isRunVisuallyActive(row) ?? false,
              ),
            ),
            Array.from(
              host.querySelectorAll<HTMLElement>("[data-catalog-session-key][data-session-key]"),
              (element) => {
                const row = catalogRowsByKey.get(element.dataset.sessionKey ?? "");
                return row ? navigation.toSidebarSession(row) : null;
              },
            ),
            areSessionCatalogsSettled(data),
            [...data.visibleSessionLimits],
          ]
        : null,
      [data.ownerCounts.counts && [...data.ownerCounts.counts], data.ownerCounts.error],
      this.admittedPresencePresentation,
      sessionsVisible
        ? [
            readers.tree().map(({ children: _children, ...row }) => row),
            sections.map(({ rows: sectionRows, ...header }) => [
              header,
              summarizeTeamSessionSlots(sectionRows, true),
              sectionRows.reduce((count, row) => count + (row.workspaceConflictCount ?? 0), 0),
            ]),
          ]
        : null,
      [...new Set([host.expandedAgentId(), ...(roster?.agentIds ?? [])])].map((id) => {
        const row = host.mainSessionRow(id);
        if (!row) {
          return null;
        }
        const { children: _children, ...home } = host.projectHomeSession(row, id);
        return home;
      }),
    ]);
    if (presentation === this.publishedSessionPresentation) {
      return false;
    }
    this.publishedSessionPresentation = presentation;
    return true;
  }

  samePresence(
    previous: PresencePayload | undefined,
    next: PresencePayload | undefined,
    scope: SidebarPresenceScope,
  ): boolean {
    this.admittedPresencePresentation = sidebarPresencePresentation(next, scope);
    return (
      previous === next ||
      sidebarPresencePresentation(previous, scope) === this.admittedPresencePresentation
    );
  }

  refreshPresencePresentation(host: SidebarPresentationHost, scope: SidebarPresenceScope): void {
    this.admittedPresencePresentation = sidebarPresencePresentation(
      host.sessionData.presencePayload,
      scope,
    );
    host.sessionData.requestSessionDataUpdate();
  }

  visibleTree(
    roots: SidebarRecentSession[],
    host: Pick<
      SidebarPresentationHost,
      "isSessionChildrenExpanded" | "isSessionChildrenFullyShown"
    >,
  ): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (host.isSessionChildrenExpanded(session)) {
        visibleSessionChildren({
          session,
          fullyShown: host.isSessionChildrenFullyShown(session.key),
        }).forEach(append);
      }
    };
    roots.forEach(append);
    return rows;
  }

  visibleRowsInOrder(
    zone: {
      entries: readonly SidebarZoneEntry[];
      sessionRows: ReadonlyMap<string, SidebarRecentSession>;
    },
    visibleRows: SidebarRecentSession[],
  ): SidebarRecentSession[] {
    const pinnedRows = zone.entries.flatMap((entry) => {
      const row = entry.type === "session" ? zone.sessionRows.get(entry.key) : undefined;
      return row ? [row] : [];
    });
    return [...pinnedRows, ...visibleRows];
  }

  childSessionParents(rows: SidebarRecentSession[], host: SidebarPresentationHost): Set<string> {
    const grouped = host.sidebarAgentsMode === "roster" ? host.rosterSessionSource : null;
    const homeAgents = grouped
      ? grouped.agentIds.filter((id) => !grouped.collapsedAgentIds.has(id))
      : [host.expandedAgentId()];
    const revalidating = new Set<string>();
    const pending = [...rows];
    for (const session of pending) {
      pending.push(...session.children);
      if (
        session.childLoadParentKeys?.length &&
        (session.visuallyActive || host.isSessionChildrenExpanded(session))
      ) {
        for (const key of session.childLoadParentKeys) {
          revalidating.add(key);
        }
      }
    }
    for (const agentId of homeAgents) {
      const mainRow = host.mainSessionRow(agentId);
      if (mainRow?.childSessions?.length) {
        for (const key of host.projectHomeSession(mainRow, agentId).childLoadParentKeys ?? []) {
          revalidating.add(key);
        }
      }
    }
    return revalidating;
  }

  mainSessionRow(
    mainKey: string,
    rows: readonly GatewaySessionRow[],
    lineage: GatewaySessionRow | null,
  ): GatewaySessionRow | null {
    return (
      (lineage ? [...rows, lineage] : rows).find((row) =>
        areUiSessionKeysEquivalent(row.key, mainKey),
      ) ?? null
    );
  }

  agentUnreadCount(
    agentId: string,
    rows: readonly GatewaySessionRow[],
    host: SidebarPresentationHost,
  ): number {
    return rows.filter(
      (row) => row.unread && !row.archived && host.sessionNavigationAgentId(row) === agentId,
    ).length;
  }

  otherAgentsHaveUnread(host: SidebarPresentationHost): boolean {
    const active = host.expandedAgentId();
    return host
      .activeChipAgent()
      .agents.some(({ id }) => normalizeAgentId(id) !== active && host.agentUnreadCount(id) > 0);
  }

  revision = 0;
  createdOrderRevision = 0;
  private observedResults: readonly { sessions: readonly { key: string }[] }[] = [];
  subtitleDeadline = Infinity;
  private readonly observedOrder = new Map<string, number>();
  private nextCreatedOrder = 0;
  private readonly stickySections = new Map<string, Set<string>>();
  readonly children = new SidebarChildExpansion(() => {
    this.revision += 1;
  });
  private readonly heldSubtitles = new Map<
    string,
    { value: SidebarSubtitleValue; catalogValue?: SidebarSubtitleValue; shownAt: number }
  >();
  private previousInput: Pick<
    SidebarProjectionInput,
    "grouping" | "sortMode" | "statusFilter" | "agentId" | "connectionIdentity" | "listSource"
  > | null = null;
  private previousCollapsedSections = new Set<string>();

  get createdOrder(): ReadonlyMap<string, number> {
    return this.observedOrder;
  }

  observeRows(results: readonly { sessions: readonly { key: string }[] }[]): void {
    if (
      results.length === this.observedResults.length &&
      results.every((value, index) => Object.is(value, this.observedResults[index]))
    ) {
      return;
    }
    this.observedResults = results;
    const previousOrder = this.nextCreatedOrder;
    for (const result of results) {
      for (const { key } of result.sessions) {
        if (key && !this.observedOrder.has(key)) {
          this.observedOrder.set(key, this.nextCreatedOrder++);
        }
      }
    }
    if (previousOrder !== this.nextCreatedOrder) {
      this.createdOrderRevision += 1;
      this.revision += 1;
    }
    // Paging gaps must retain their tie-break index; evict absent keys only
    // when the sidebar-lifetime registry actually exceeds its memory bound.
    if (this.observedOrder.size <= SIDEBAR_CREATED_ORDER_CAP) {
      return;
    }
    const retainedKeys = new Set(
      results.flatMap((result) => result.sessions.map(({ key }) => key)),
    );
    for (const key of this.observedOrder.keys()) {
      if (this.observedOrder.size <= SIDEBAR_CREATED_ORDER_CAP) {
        break;
      }
      if (!retainedKeys.has(key)) {
        this.observedOrder.delete(key);
      }
    }
  }

  promoteCreatedSession(key: string): boolean {
    const currentOrder = this.observedOrder.get(key);
    if (currentOrder === 0) {
      return false;
    }
    for (const [existingKey, order] of this.observedOrder) {
      if (existingKey !== key && (currentOrder === undefined || order < currentOrder)) {
        this.observedOrder.set(existingKey, order + 1);
        this.nextCreatedOrder = Math.max(this.nextCreatedOrder, order + 2);
      }
    }
    this.observedOrder.set(key, 0);
    this.nextCreatedOrder = Math.max(this.nextCreatedOrder, 1);
    this.createdOrderRevision += 1;
    this.revision += 1;
    return true;
  }

  project(input: SidebarProjectionInput): SidebarVisibleSections {
    // Record the state published by this pass, including sticky membership and subtitles.
    this.revision += 1;
    this.subtitleDeadline = Infinity;
    const previous = this.previousInput;
    const scopeChanged =
      previous !== null &&
      (previous.agentId !== input.agentId ||
        previous.connectionIdentity !== input.connectionIdentity ||
        previous.listSource !== input.listSource);
    if (
      scopeChanged ||
      (previous !== null &&
        // Grouping changes can re-emit the same section id (e.g. ungrouped)
        // with a different row population; stale sticky keys must not carry over.
        (previous.grouping !== input.grouping ||
          previous.sortMode !== input.sortMode ||
          previous.statusFilter !== input.statusFilter))
    ) {
      this.resetMembership();
    }
    this.children.beginPass(
      previous !== null &&
        (previous.agentId !== input.agentId ||
          previous.connectionIdentity !== input.connectionIdentity),
    );
    if (scopeChanged) {
      this.heldSubtitles.clear();
    }
    for (const sectionId of input.collapsedSections) {
      if (!this.previousCollapsedSections.has(sectionId)) {
        this.resetMembership(sectionId);
      }
    }
    this.previousInput = {
      grouping: input.grouping,
      sortMode: input.sortMode,
      statusFilter: input.statusFilter,
      agentId: input.agentId,
      connectionIdentity: input.connectionIdentity,
      listSource: input.listSource,
    };
    this.previousCollapsedSections = new Set(input.collapsedSections);

    const staleKeys = new Set([...this.children.keys(), ...this.heldSubtitles.keys()]);
    const observeTree = (session: SidebarRecentSession) => {
      staleKeys.delete(session.key);
      this.children.observe(session, input.listLoaded);
      this.observeSubtitle(session, input.subtitle);
      for (const child of session.children) {
        observeTree(child);
      }
    };
    input.rows.forEach(observeTree);
    for (const key of staleKeys) {
      this.children.delete(key);
      this.heldSubtitles.delete(key);
    }

    const { grouping, knownGroups, selfOwnerId, sectionOrder, catalogIds } = input;
    const hideEmptyGroups =
      input.emptyGroupsMode === "always" ||
      (input.emptyGroupsMode === "filtering" && input.ownerFiltered);
    const sections =
      input.sections ??
      groupSidebarSessionRows(input.rows, {
        grouping,
        knownGroups,
        selfOwnerId,
        sectionOrder,
        catalogIds,
      }).filter(
        (section) =>
          section.id !== "pinned" &&
          // Catalog rows have their own projection; these sections are placeholders.
          !(hideEmptyGroups && !section.id.startsWith("catalog:") && section.rows.length === 0),
      );
    const sectionIds = new Set<string>(sections.map((section) => section.id));
    for (const sectionId of this.stickySections.keys()) {
      if (!sectionIds.has(sectionId)) {
        this.stickySections.delete(sectionId);
      }
    }
    // A lone catch-all sits directly under the global Sessions toolbar. Empty
    // Coding does not render, while empty custom/Groups sections remain targets.
    // Headerless means no collapse control, so a stored ungrouped-collapsed
    // preference is deliberately inert here; it re-applies once a peer returns.
    // Flat mode ("none") holds every native row, so its "Other" label would
    // lie; it stays headerless even beside catalog sections.
    const ungroupedHasPeerHeader =
      input.grouping !== "none" &&
      sections.some(
        (section) =>
          section.id !== "ungrouped" && (section.id !== "work" || section.rows.length > 0),
      );
    const visibleRows: SidebarRecentSession[] = [];
    const limitedSections: SidebarVisibleSections["sections"] = [];
    for (const section of sections) {
      // totalRowCount is the pre-pagination size: headers and empty-zone
      // checks must not mistake a page-filtered section for an empty one.
      const totalRowCount = section.rows.length;
      const renderHeader =
        !section.id.startsWith("agent:") && (section.id !== "ungrouped" || ungroupedHasPeerHeader);
      const collapsed =
        (renderHeader || section.id.startsWith("agent:")) &&
        input.collapsedSections.has(section.id);
      const visibleLimit = input.visibleSessionLimits.get(section.id) ?? SIDEBAR_SESSION_PAGE_SIZE;
      const requiredRowCount = section.rows.reduce(
        (count, row) => count + Number(row.active || row.pinned),
        0,
      );
      const collapsedVisibleRowCount = Math.max(
        requiredRowCount,
        Math.min(totalRowCount, SIDEBAR_SESSION_PAGE_SIZE),
      );
      let visibleRowCount = 0;
      if (!collapsed) {
        let optionalSlots = Math.max(0, visibleLimit - requiredRowCount);
        let retainedSlots = visibleLimit;
        const sticky = this.stickySections.get(section.id);
        // Keep one prior page through run-state and recency changes. An unbounded
        // union eventually renders the entire roster without a Show more action.
        section.rows = section.rows.filter((row) => {
          if (row.active || row.pinned) {
            return true;
          }
          if (optionalSlots > 0) {
            optionalSlots -= 1;
            return true;
          }
          if (retainedSlots === 0 || !sticky?.has(row.key)) {
            return false;
          }
          retainedSlots -= 1;
          return true;
        });
        this.stickySections.set(section.id, new Set(section.rows.map((row) => row.key)));
        visibleRows.push(...section.rows);
        visibleRowCount = section.rows.length;
      }
      limitedSections.push(
        Object.assign(section, {
          totalRowCount,
          visibleRowCount,
          visibleLimit,
          collapsedVisibleRowCount,
          renderHeader,
        }),
      );
    }
    return { sections: limitedSections, visibleRows };
  }

  resetMembership(sectionId?: string): void {
    this.revision += 1;
    if (sectionId === undefined) {
      this.stickySections.clear();
    } else {
      this.stickySections.delete(sectionId);
    }
  }

  invalidate(): void {
    this.subtitleDeadline = Infinity;
    this.revision += 1;
  }

  resolveSubtitle(params: SidebarSubtitleParams): SidebarSubtitleValue {
    // While a run is live the held value is the display: observeSubtitle
    // refreshed it this update pass, applying the minimum-display floor.
    // Tool identity and its prepared progress must advance together; the
    // ambient narration hold must not pair a new glyph with an old tool label.
    const held =
      params.session.hasActiveRun && params.showPreview && !params.toolActivity
        ? this.heldSubtitles.get(params.session.key)
        : undefined;
    if (!held) {
      return resolveSidebarSessionSubtitle(params);
    }
    return params.hasDisplay
      ? (held.catalogValue ?? resolveSidebarSessionSubtitle(params))
      : held.value;
  }

  private observeSubtitle(
    session: SidebarRecentSession,
    environment: SidebarProjectionInput["subtitle"],
  ): void {
    if (!session.hasActiveRun || !environment.showPreview) {
      this.heldSubtitles.delete(session.key);
      return;
    }
    if (!environment.sidebarLiveActivity && this.heldSubtitles.get(session.key)?.value.narration) {
      this.heldSubtitles.delete(session.key);
    }
    const params = {
      session,
      hasDisplay: false,
      sidebarLiveActivity: environment.sidebarLiveActivity,
      showPreview: environment.showPreview,
      narrationLine: environment.narrationLines.get(session.key),
      observerDigest: environment.observerDigests.get(session.key) ?? null,
    } satisfies SidebarSubtitleParams;
    const value = resolveSidebarSessionSubtitle(params);
    if (!value.subtitle) {
      if (session.attention.kind === "question" || session.attention.kind === "error") {
        this.heldSubtitles.delete(session.key);
      }
      // Transient gaps between event updates keep the last shown line; the
      // hold dies with the run (the hasActiveRun branch above).
      return;
    }
    const held = this.heldSubtitles.get(session.key);
    const now = this.now();
    const replacing = held !== undefined && held.value.subtitle !== value.subtitle;
    if (
      replacing &&
      now - held.shownAt < SIDEBAR_SUBTITLE_MIN_DISPLAY_MS &&
      !isOperatorCriticalSubtitle(session)
    ) {
      this.subtitleDeadline = Math.min(
        this.subtitleDeadline,
        held.shownAt + SIDEBAR_SUBTITLE_MIN_DISPLAY_MS,
      );
      return;
    }
    const catalogValue = resolveSidebarSessionSubtitle({ ...params, hasDisplay: true });
    this.heldSubtitles.set(session.key, {
      value,
      ...(catalogValue.subtitle ? { catalogValue } : {}),
      shownAt: held !== undefined && !replacing ? held.shownAt : now,
    });
  }
}
