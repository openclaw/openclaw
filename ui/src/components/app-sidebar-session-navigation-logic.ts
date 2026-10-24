import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { resolveSessionChannelPresentation } from "../lib/session-channel.ts";
import {
  isSessionTitlePending,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkContext,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import { resolveSessionRenameValue } from "../lib/session-rename.ts";
import { isSessionRunStateActive } from "../lib/session-run-state.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  resolveSessionNavigation,
  sessionMatchesVisibleSessionScope,
} from "../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isSubagentSessionKey,
  isPinnableUiSessionRow,
  isUiGlobalScopeConfigured,
  normalizeAgentId,
  readSessionDefaults,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.tsx";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { sidebarPluginTabs } from "./app-sidebar-nav-menus.tsx";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { resolveCloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SidebarSessionRowProjection } from "./sidebar-projection-cache.ts";
import { restoreSnapshotSession, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type SessionRow = SessionsListResult["sessions"][number];

type SidebarSessionSortOptions = {
  sortMode: SidebarSessionSortMode;
  owners: SessionsListResult["owners"];
  createdOrder: ReadonlyMap<string, number>;
};

export function createSidebarSessionRowsComparator(
  readOptions: () => SidebarSessionSortOptions,
): (a: SessionRow, b: SessionRow) => number {
  let options: SidebarSessionSortOptions | undefined;
  let ownerLabels: Map<string, string | undefined> | undefined;
  return (a, b) => {
    // An unset agent selection can resolve through navigation itself. Empty
    // and single-row projections must not ask for sort facts before sorting.
    const input = (options ??= readOptions());
    if (input.sortMode !== "people") {
      return input.sortMode === "updated"
        ? compareSessionRowsByUpdatedAt(a, b)
        : compareSidebarSessionRowsByCreatedAt(a, b, input.createdOrder);
    }
    const ownerA = a.owner?.actor;
    const ownerB = b.owner?.actor;
    const idA = ownerA?.id?.trim() ?? "";
    const idB = ownerB?.id?.trim() ?? "";
    if (idA !== idB) {
      if (!ownerLabels) {
        ownerLabels = new Map();
        for (const owner of input.owners ?? []) {
          if (!ownerLabels.has(owner.id)) {
            ownerLabels.set(owner.id, owner.label?.trim());
          }
        }
      }
      const labelA = ownerLabels.get(idA) || ownerA?.label?.trim() || idA;
      const labelB = ownerLabels.get(idB) || ownerB?.label?.trim() || idB;
      const byOwner = labelA.localeCompare(labelB) || idA.localeCompare(idB);
      if (byOwner !== 0) {
        return byOwner;
      }
    }
    return compareSidebarSessionRowsByCreatedAt(a, b, input.createdOrder);
  };
}

function compareSidebarSessionRowsByCreatedAt(
  a: SessionRow,
  b: SessionRow,
  createdOrder: ReadonlyMap<string, number>,
): number {
  const createdAtA = asNonNegativeFiniteNumber(a.createdAt) ?? null;
  const createdAtB = asNonNegativeFiniteNumber(b.createdAt) ?? null;
  if (createdAtA !== null || createdAtB !== null) {
    if (createdAtA === null) {
      return 1;
    }
    if (createdAtB === null) {
      return -1;
    }
    const byCreatedAt = createdAtB - createdAtA;
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
  }
  const byObservedOrder =
    (createdOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
    (createdOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER);
  return byObservedOrder || a.key.localeCompare(b.key);
}

export type SidebarSessionNavigationState = {
  routeSessionKey: string;
  selectedAgentId: string;
  activeRowKey: string | null;
  visibleSessionRows: GatewaySessionRow[];
  toSidebarSession: (row: SessionRow, isChild?: boolean) => SidebarRecentSession;
};

export function buildSidebarSessionNavigationState(input: {
  context: ApplicationContext | undefined;
  routeSessionKey: string;
  sessionsResult: SessionsListResult | null;
  activeSession?: GatewaySessionRow | null;
  sessionsAgentId: string | null;
  showCron: boolean;
  showSystem: boolean;
  statusFilter: SidebarSessionStatusFilter;
  compareSessions: (a: SessionRow, b: SessionRow) => number;
  highlightCurrentSession: boolean;
  rowProjection: SidebarSessionRowProjection;
  loadingChildSessionKeys: ReadonlySet<string>;
  outboxAttentionCountForSessionKey: (sessionKey: string) => number;
  hasSessionDraft: (sessionKey: string) => boolean;
  resolveAttention: (row: GatewaySessionRow) => SidebarRecentSession["attention"];
  resolveAgentStatusNote: (row: GatewaySessionRow) => string | undefined;
}): SidebarSessionNavigationState {
  const { context } = input;
  const defaultAgentId = resolveUiDefaultAgentId({
    agentsList: context?.agents.state.agentsList,
    hello: context?.gateway.snapshot.hello,
  });
  const navigation = resolveSessionNavigation({
    result: input.sessionsResult,
    activeSession: input.activeSession,
    resultAgentId: input.sessionsAgentId,
    sessionKey: input.routeSessionKey,
    assistantAgentId:
      context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
    hello: context?.gateway.snapshot.hello,
    showCron: input.showCron,
    showSystem: input.showSystem,
    archivedFilter: input.statusFilter,
    compareSessions: input.compareSessions,
  });
  const toSidebarSession = (row: SessionRow, isChild = false): SidebarRecentSession => {
    const active = row.key === navigation.activeRowKey;
    const visuallyActive =
      input.highlightCurrentSession && row.key === navigation.currentSessionKey;
    const selfUserId = context?.gateway.snapshot.selfUser?.id;
    const isRunVisuallyActive =
      row.archived !== true &&
      (context ? context.sessions.isRunVisuallyActive(row) : isSessionRunStateActive(row));
    const workSession =
      Boolean(row.worktree || row.repository || row.execNode) ||
      context?.sessions.isPreparedWorkSession(row.key) === true;
    const pullRequest = context?.sessions.pullRequestSummary(row.key);
    const outboxAttentionCount = input.outboxAttentionCountForSessionKey(row.key);
    const hasComposerDraft = row.incognito !== true && input.hasSessionDraft(row.key);
    const agentStatusNote = input.resolveAgentStatusNote(row);
    const loadingChildren = input.loadingChildSessionKeys.has(row.key);
    return input.rowProjection.read(
      row,
      isChild,
      [
        context,
        defaultAgentId,
        selfUserId,
        i18n.getLocale(),
        active,
        visuallyActive,
        isRunVisuallyActive,
        workSession,
        pullRequest,
        outboxAttentionCount,
        hasComposerDraft,
        input.resolveAttention,
        agentStatusNote,
        loadingChildren,
      ],
      () => {
        const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
        let runtimeSampledAt = row.runtimeSampledAt;
        if (row.runtimeMs != null && runtimeSampledAt == null) {
          runtimeSampledAt = input.rowProjection.runtimeSampledAtByRow.get(row);
          if (runtimeSampledAt == null) {
            runtimeSampledAt = Date.now();
            input.rowProjection.runtimeSampledAtByRow.set(row, runtimeSampledAt);
          }
        }
        return {
          key: row.key,
          agentId: resolveUiSessionRowAgentId(row, defaultAgentId),
          sessionId: row.sessionId,
          displayName: row.displayName,
          titlePending: isSessionTitlePending(row.key, row),
          incognito: row.incognito === true || isIncognitoSessionKey(row.key),
          createdActor: row.createdActor,
          owner: row.owner,
          participants: row.participants,
          expandedParticipants: row.expandedParticipants,
          participantCount: row.participantCount,
          archivedBy: row.archivedBy,
          // Parent attention attributes subagent failures with the worker's own label.
          label: resolveSessionDisplayName(row.key, row),
          userLabel: row.label,
          renameValue: resolveSessionRenameValue(row),
          subtitle: resolveSessionWorkSubtitle(row),
          workContext: resolveSessionWorkContext(row),
          active,
          visuallyActive,
          hasActiveRun: row.archived !== true && isSessionRunStateActive(row),
          isRunVisuallyActive,
          gatewayHasActiveRun: row.hasActiveRun,
          hasActiveSubagentRun: row.hasActiveSubagentRun,
          activeRunIds: row.archived === true ? undefined : row.activeRunIds,
          modelSelectionLocked: row.modelSelectionLocked === true,
          kind: row.kind,
          pinned: row.pinned === true,
          pinnable: isPinnableUiSessionRow(row),
          sidebarRoot: row.sidebarRoot,
          snoozedUntil: row.snoozedUntil,
          archived: row.archived === true,
          visibility: row.visibility,
          sharingRole: row.sharingRole,
          communication: row.communication,
          effectiveCommunication: row.effectiveCommunication,
          draftOwnedBySelf:
            row.visibility === "draft" &&
            (row.sharingRole === "owner" ||
              Boolean(selfUserId && row.createdActor?.id === selfUserId)),
          category: normalizeOptionalString(row.category),
          icon: normalizeOptionalString(row.icon),
          color: normalizeOptionalString(row.color),
          channelAvatarUrl: normalizeOptionalString(row.channelAvatarUrl),
          boardFace: row.boardFace,
          channel: channelInfo.channel,
          channelSession: channelInfo.channelSession,
          channelPresentation: resolveSessionChannelPresentation(row),
          workSession,
          acpSession: isAcpSessionKey(row.key),
          worktreeId: row.worktree?.id,
          // A cwd or a prepared session does not prove repository identity.
          workspaceKind: row.worktree ? "worktree" : row.repository ? "checkout" : undefined,
          execNode: row.execNode,
          placementState: row.placement?.state,
          placementProviderId:
            row.placement && "providerId" in row.placement ? row.placement.providerId : undefined,
          placementProfileId:
            row.placement && "profileId" in row.placement ? row.placement.profileId : undefined,
          placementMachine:
            row.placement && "machine" in row.placement ? row.placement.machine : undefined,
          diskSpaceStatus:
            row.placement?.state === "active" ? row.placement.diskSpace?.status : undefined,
          workspaceConflictCount:
            row.placement && "workspaceResultConflict" in row.placement
              ? Math.max(
                  row.placement.workspaceResultConflict?.paths.length ?? 0,
                  row.placement.workspaceResultConflict?.totalCount ?? 0,
                ) || undefined
              : undefined,
          cloudWorkerStopAction: resolveCloudWorkerStopAction(row.placement),
          hasAutomation: row.hasAutomation === true,
          pullRequest,
          outboxAttentionCount,
          hasComposerDraft,
          unread: row.archived !== true && row.unread === true,
          hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
          lastMessagePreview: normalizeOptionalString(row.lastMessagePreview),
          lastReadAt: row.lastReadAt,
          attention:
            row.archived === true ? SIDEBAR_SESSION_NO_ATTENTION : input.resolveAttention(row),
          agentStatusNote,
          observerDigest: row.observerDigest,
          spawnedBy: row.spawnedBy,
          forkSource: row.forkSource,
          status: row.status,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          updatedAt: row.updatedAt,
          endedAt: row.endedAt,
          runtimeMs: row.runtimeMs,
          runtimeSampledAt,
          childSessionKeys:
            row.archived === true
              ? []
              : (row.childSessions ?? []).filter((key) => !isSubagentSessionKey(key)),
          children: [],
          isChild,
          loadingChildren,
          containsActiveDescendant: false,
          runningChildCount: 0,
          failedChildCount: 0,
        };
      },
    );
  };
  return {
    routeSessionKey: navigation.currentSessionKey,
    selectedAgentId: navigation.selectedAgentId,
    activeRowKey: navigation.activeRowKey,
    visibleSessionRows: navigation.visibleSessions,
    toSidebarSession,
  };
}

export function buildReconciledSidebarZone(input: {
  sidebarEntries: readonly string[];
  rows: SidebarRecentSession[];
  pluginNavigation: readonly ControlUiRegistration<ControlUiNavigationItem>[];
  pluginTabs: readonly GatewayControlUiPluginTab[] | undefined;
  snapshot?: { model: SidebarSnapshotModel; selectedKey: string };
  pendingPlugins?: Pick<SidebarSnapshotModel, "entries" | "plugins"> | null;
}) {
  if (input.snapshot) {
    const { model, selectedKey } = input.snapshot;
    const restoredRows = [...model.sessions, ...model.pinnedSessions].map((row) =>
      restoreSnapshotSession(row, selectedKey),
    );
    return {
      entries: model.entries.flatMap((entry) => {
        const parsed = parseSidebarEntry(entry);
        return parsed ? [parsed] : [];
      }),
      sidebarEntries: model.entries,
      sessionRows: new Map(restoredRows.map((row) => [row.key, row])),
      pluginTabs: new Map(model.plugins.map(({ key, ...tab }) => [key, tab])),
    };
  }
  const navigation = input.pluginNavigation;
  const occupiedPlacements = new Set(SIDEBAR_NAV_ROUTES.map((route) => `route:${route}`));
  const pluginTabs = new Map(
    sidebarPluginTabs(input.pluginTabs)
      .filter(
        (tab) =>
          (!tab.placement || !occupiedPlacements.has(tab.placement)) &&
          !navigation.some(
            (entry) => entry.pluginId === tab.pluginId && entry.value.page.id === tab.id,
          ),
      )
      .map((tab) => [pluginTabKey(tab), tab]),
  );
  const availableRows = input.rows;
  const sidebarEntries = input.sidebarEntries;
  const pluginNavigationKeys = new Set([
    ...pluginTabs.keys(),
    ...navigation.map((entry) => entry.key),
  ]);
  // Personal references are the only pin authority. Catalogs resolve display, never membership.
  const sessionKeys = new Set(availableRows.map(({ key }) => key));
  const routes = new Set(SIDEBAR_NAV_ROUTES);
  const canonical = new Set<string>();
  const entries: SidebarZoneEntry[] = [];
  for (const serialized of sidebarEntries) {
    const entry = parseSidebarEntry(serialized);
    if (!entry) {
      continue;
    }
    const key = serializeSidebarEntry(entry);
    if (canonical.has(key)) {
      continue;
    }
    canonical.add(key);
    // Preserve unresolved references without persisting private labels or treating
    // a missing paginated row, offline person, or unloaded plugin as an unpin.
    if (
      entry.type === "person" ||
      (entry.type === "route" && routes.has(entry.route)) ||
      (entry.type === "session" && sessionKeys.has(entry.key)) ||
      (entry.type === "plugin" && pluginNavigationKeys.has(entry.key))
    ) {
      entries.push(entry);
    }
  }
  const live = {
    entries,
    sidebarEntries: [...canonical],
    sessionRows: new Map(availableRows.map((row) => [row.key, row])),
    pluginTabs,
  };
  const retained = input.pendingPlugins;
  if (retained) {
    const visible = new Set(live.entries.map(serializeSidebarEntry));
    for (const [index, key] of retained.entries.entries()) {
      const entry = parseSidebarEntry(key);
      if (entry?.type !== "plugin" || visible.has(key)) {
        continue;
      }
      const tab = retained.plugins.find((plugin) => plugin.key === entry.key);
      if (!tab) {
        continue;
      }
      live.pluginTabs.set(entry.key, tab);
      const following = retained.entries
        .slice(index + 1)
        .find((candidate) => visible.has(candidate));
      const position = following
        ? live.entries.findIndex((candidate) => serializeSidebarEntry(candidate) === following)
        : live.entries.length;
      live.entries.splice(position, 0, entry);
      visible.add(key);
    }
  }
  return live;
}

/** Menus read selection synchronously; the sidebar projection owns publication and parking. */
export function createSidebarSessionSelection(
  readRows: () => readonly SidebarRecentSession[],
  publish: () => void,
) {
  let selectedKeys: ReadonlySet<string> = new Set();
  let anchor: string | null = null;
  return {
    get selectedKeys() {
      return selectedKeys;
    },
    toggle(key: string) {
      const next = new Set(selectedKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      selectedKeys = next;
      anchor = next.has(key) ? key : null;
      publish();
    },
    extend(key: string) {
      const rows = readRows();
      anchor ??= rows.find((row) => row.visuallyActive || row.active)?.key ?? key;
      const anchorIndex = rows.findIndex((row) => row.key === anchor);
      const targetIndex = rows.findIndex((row) => row.key === key);
      if (anchorIndex === -1 || targetIndex === -1) {
        selectedKeys = new Set([key]);
        anchor = key;
      } else {
        const [start, end] =
          anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        selectedKeys = new Set(rows.slice(start, end + 1).map((row) => row.key));
      }
      publish();
    },
    clear(this: void) {
      anchor = null;
      if (selectedKeys.size > 0) {
        selectedKeys = new Set();
        publish();
      }
    },
  };
}

export function resolveActiveSidebarAgent(input: {
  activeId: string;
  roster: NonNullable<ApplicationContext["agents"]["state"]["agentsList"]>["agents"];
  identities: ReturnType<ApplicationContext["agentIdentity"]["entries"]>;
}) {
  const identities = new Map(
    input.identities.map((identity) => [identity.agentId, identity] as const),
  );
  return {
    activeId: input.activeId,
    agent: input.roster.find((entry) => normalizeAgentId(entry.id) === input.activeId),
    agents: listSelectableAgents(input.roster),
    identity: identities.get(input.activeId) ?? null,
    identities,
  };
}

export function resolveLatestSidebarAgentSession(input: {
  agentId: string;
  result: SessionsListResult | null;
  context: ApplicationContext | undefined;
}): SessionRow | null {
  const normalized = normalizeAgentId(input.agentId);
  // Unprefixed keys belong to the system default agent. Keeping them for
  // another agent would resume the wrong conversation with the raw key.
  const visible = filterVisibleSessionRows(input.result?.sessions ?? [], {
    agentId: normalized,
    defaultAgentId: resolveUiDefaultAgentId({
      agentsList: input.context?.agents.state.agentsList,
      hello: input.context?.gateway.snapshot.hello,
    }),
    filterByAgent: true,
    archivedFilter: "active",
  });
  return visible.reduce<SessionRow | null>(
    (latest, row) =>
      latest !== null && compareSessionRowsByUpdatedAt(latest, row) <= 0 ? latest : row,
    null,
  );
}

export function collectSidebarSessionRowsByKey(input: {
  rows: readonly GatewaySessionRow[];
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
}): ReadonlyMap<string, GatewaySessionRow> {
  return new Map(
    [...Object.values(input.childRowsByParent).flat(), ...input.rows].map((row) => [row.key, row]),
  );
}

export function collectCategorizedChildRootRows(input: {
  rows: readonly GatewaySessionRow[];
  scopedRoots: readonly GatewaySessionRow[];
  visibilityOptions: Parameters<typeof filterVisibleSessionRows>[1];
}): GatewaySessionRow[] {
  const scopedRootKeys = new Set(input.scopedRoots.map((row) => row.key));
  return input.rows.filter(
    (row) =>
      !scopedRootKeys.has(row.key) &&
      !isSubagentSessionKey(row.key) &&
      (row.sidebarRoot === true || normalizeOptionalString(row.category) != null) &&
      resolveUiSessionNavigationParentKey(row) != null &&
      sessionMatchesVisibleSessionScope(row, input.visibilityOptions),
  );
}

export function collectKnownSidebarSessionCatalogIds(input: {
  loadedCatalogIds: readonly string[];
  hasLoaded: boolean;
  sectionOrder: readonly string[];
}): string[] {
  if (input.hasLoaded) {
    return [...input.loadedCatalogIds];
  }
  // Until the first authoritative list completes, progressive rows are only
  // a partial view. Preserve stored slots so an unrelated drag cannot erase them.
  const storedCatalogIds = input.sectionOrder.flatMap((sectionId) =>
    sectionId.startsWith("catalog:") ? [sectionId.slice("catalog:".length)] : [],
  );
  return [...new Set([...input.loadedCatalogIds, ...storedCatalogIds])];
}

export function resolveSidebarMainSessionKey(input: {
  agentId: string;
  agentsList: ApplicationContext["agents"]["state"]["agentsList"] | undefined;
  hello: ApplicationContext["gateway"]["snapshot"]["hello"] | undefined;
}): string {
  const host = { agentsList: input.agentsList, hello: input.hello };
  // Global-scope gateways advertise the canonical main session as the
  // literal "global" key; a synthesized agent key would never match it.
  if (isUiGlobalScopeConfigured(host)) {
    return normalizeOptionalString(readSessionDefaults(host)?.mainSessionKey) ?? "global";
  }
  return buildAgentMainSessionKey({
    agentId: input.agentId,
    mainKey: resolveUiConfiguredMainKey(host),
  });
}

/** Search the projected tree without flattening folded descendant state. */
export function findSidebarSessionInTree(
  roots: readonly SidebarRecentSession[],
  predicate: (row: SidebarRecentSession) => boolean,
): SidebarRecentSession | undefined {
  const pending = [...roots];
  for (let row = pending.pop(); row; row = pending.pop()) {
    if (predicate(row)) {
      return row;
    }
    pending.push(...row.children);
  }
  return undefined;
}

export function findProjectedSidebarSession(input: {
  sessionKey: string;
  navigationState: SidebarSessionNavigationState;
  sessionResultsByAgent: Readonly<Record<string, SessionsListResult>>;
}): SidebarRecentSession | undefined {
  const active = input.navigationState.visibleSessionRows.find(
    (candidate) => candidate.key === input.sessionKey,
  );
  if (active) {
    return input.navigationState.toSidebarSession(active);
  }
  for (const result of Object.values(input.sessionResultsByAgent)) {
    const row = result.sessions.find((candidate) => candidate.key === input.sessionKey);
    if (row) {
      return input.navigationState.toSidebarSession(row);
    }
  }
  return undefined;
}

/** Live canonical requests outlive a paginated row, but never supply its old private metadata. */
export function projectSidebarVisibleMainSession(
  host: {
    mainSessionRow(agentId: string): GatewaySessionRow | null;
    projectHomeSession(
      row: GatewaySessionRow,
      agentId: string,
    ): SidebarRecentSession & { metadataVisible: boolean };
    selectedAgentMainSessionKey(agentId: string): string;
    readonly sessionOwnerFilterActive: boolean;
    readonly sessionInvolvingMeFilterActive: boolean;
    readonly sessionsStatusFilter: SidebarSessionStatusFilter;
    readonly sessionDataContext: Pick<ApplicationContext, "sessions"> | undefined;
    getSessionNavigationState(): SidebarSessionNavigationState;
    resolveSessionAttention(
      row: Pick<GatewaySessionRow, "key" | "agentId">,
    ): SidebarRecentSession["attention"];
  },
  agentId: string,
): SidebarRecentSession | null {
  const row = host.mainSessionRow(agentId);
  if (row) {
    const home = host.projectHomeSession(row, agentId);
    return home.metadataVisible ? home : null;
  }
  const key = host.selectedAgentMainSessionKey(agentId);
  if (
    host.sessionOwnerFilterActive ||
    host.sessionInvolvingMeFilterActive ||
    (host.sessionsStatusFilter !== "active" && host.sessionsStatusFilter !== "all") ||
    host.sessionDataContext?.sessions.deletionState(key, agentId)
  ) {
    return null;
  }
  const attention = host.resolveSessionAttention({ key, agentId });
  if (attention.kind !== "question" && attention.kind !== "approval") {
    return null;
  }
  return {
    ...host
      .getSessionNavigationState()
      .toSidebarSession({ key, agentId, kind: "direct", updatedAt: 0 }),
    label: "",
    renameValue: "",
    attention,
    ownAttention: attention,
    pullRequest: undefined,
    agentStatusNote: undefined,
    workSession: false,
    outboxAttentionCount: 0,
    hasComposerDraft: false,
  };
}
