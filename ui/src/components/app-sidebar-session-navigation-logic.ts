import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { SIDEBAR_NAV_ROUTES } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { resolveSessionChannelPresentation } from "../lib/session-channel.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkContext,
  resolveSessionWorkSubtitle,
} from "../lib/session-display.ts";
import { resolveSessionRenameValue } from "../lib/session-rename.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import { collectKnownSessionGroups } from "../lib/sessions/grouping.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
  resolveSessionNavigation,
  sessionMatchesVisibleSessionScope,
} from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
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
import { reconcileSidebarZone } from "../lib/sidebar-zone.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { sidebarPluginTabs } from "./app-sidebar-nav-menus.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { resolveCloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionAttentionController } from "./session-attention-controller.ts";

type SessionRow = SessionsListResult["sessions"][number];

export function resolveSidebarHomeAttention(
  attention: SessionAttentionController,
  sessionKey: string,
  row: GatewaySessionRow | null,
) {
  const known = summarizeSidebarSessionAttention(
    attention
      .knownSessionAttention()
      .filter((entry) => areUiSessionKeysEquivalent(entry.sessionKey, sessionKey))
      .map((entry) => entry.attention),
  );
  return known.kind !== "none"
    ? known
    : row
      ? attention.resolveSessionAttention(row)
      : SIDEBAR_SESSION_NO_ATTENTION;
}

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
  const createdAtA =
    typeof a.createdAt === "number" && Number.isFinite(a.createdAt) && a.createdAt >= 0
      ? a.createdAt
      : null;
  const createdAtB =
    typeof b.createdAt === "number" && Number.isFinite(b.createdAt) && b.createdAt >= 0
      ? b.createdAt
      : null;
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

function isSidebarDraftOwnedBySelf(
  row: Pick<SessionRow, "createdActor" | "sharingRole" | "visibility">,
  selfUserId: string | undefined,
): boolean {
  return (
    row.visibility === "draft" &&
    (row.sharingRole === "owner" || Boolean(selfUserId && row.createdActor?.id === selfUserId))
  );
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
  runtimeSampledAtByRow: WeakMap<GatewaySessionRow, number>;
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
    const channelInfo = resolveChannelSessionInfo(row.key, row.channel);
    let runtimeSampledAt = row.runtimeSampledAt;
    if (row.runtimeMs != null && runtimeSampledAt == null) {
      runtimeSampledAt = input.runtimeSampledAtByRow.get(row);
      if (runtimeSampledAt == null) {
        runtimeSampledAt = Date.now();
        input.runtimeSampledAtByRow.set(row, runtimeSampledAt);
      }
    }
    return {
      key: row.key,
      agentId: resolveUiSessionRowAgentId(row, defaultAgentId),
      sessionId: row.sessionId,
      displayName: row.displayName,
      incognito: row.incognito === true,
      createdActor: row.createdActor,
      owner: row.owner,
      participants: row.participants,
      expandedParticipants: row.expandedParticipants,
      participantCount: row.participantCount,
      archivedBy: row.archivedBy,
      // Parent attention attributes subagent failures with the worker's own label.
      label: resolveSessionDisplayName(row.key, row, { includeSubagentPrefix: false }),
      userLabel: row.label,
      renameValue: resolveSessionRenameValue(row),
      subtitle: resolveSessionWorkSubtitle(row),
      workContext: resolveSessionWorkContext(row),
      active: row.key === navigation.activeRowKey,
      visuallyActive: input.highlightCurrentSession && row.key === navigation.currentSessionKey,
      // Normalize optional gateway state before collapsing it to the sidebar's required fact.
      hasActiveRun: row.archived !== true && isSessionRunActive(row),
      gatewayHasActiveRun: row.hasActiveRun,
      activeRunIds: row.archived === true ? undefined : row.activeRunIds,
      modelSelectionLocked: row.modelSelectionLocked === true,
      kind: row.kind,
      pinned: row.pinned === true,
      pinnable: isPinnableUiSessionRow(row),
      archived: row.archived === true,
      visibility: row.visibility,
      draftOwnedBySelf: isSidebarDraftOwnedBySelf(row, context?.gateway.snapshot.selfUser?.id),
      category: normalizeOptionalString(row.category),
      icon: normalizeOptionalString(row.icon),
      color: normalizeOptionalString(row.color),
      channelAvatarUrl: normalizeOptionalString(row.channelAvatarUrl),
      boardFace: row.boardFace,
      channel: channelInfo.channel,
      channelSession: channelInfo.channelSession,
      channelPresentation: resolveSessionChannelPresentation(row),
      workSession:
        Boolean(row.worktree || row.repository || row.execNode) ||
        context?.sessions.isPreparedWorkSession(row.key) === true,
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
      pullRequest: context?.sessions.pullRequestSummary(row.key),
      outboxAttentionCount: input.outboxAttentionCountForSessionKey(row.key),
      hasComposerDraft: input.hasSessionDraft(row.key),
      unread: row.archived !== true && row.unread === true,
      hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
      lastMessagePreview: normalizeOptionalString(row.lastMessagePreview),
      lastReadAt: row.lastReadAt,
      attention: row.archived === true ? SIDEBAR_SESSION_NO_ATTENTION : input.resolveAttention(row),
      agentStatusNote: input.resolveAgentStatusNote(row),
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
      loadingChildren: input.loadingChildSessionKeys.has(row.key),
      containsActiveDescendant: false,
      runningChildCount: 0,
      failedChildCount: 0,
    };
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
}) {
  const navigation = input.pluginNavigation;
  const occupiedPlacements = new Set(input.sidebarEntries);
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
  const defaultPluginNavigationKeys = new Set([
    ...pluginTabs.keys(),
    ...navigation
      .filter((entry) => entry.value.defaultVisible !== false)
      .toSorted((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0) || a.key.localeCompare(b.key))
      .map((entry) => entry.key),
  ]);
  const pinnedRows = input.rows.filter((row) => row.pinned);
  // Only loaded rows count as authoritative unpinned state; entries for
  // other agents' sessions must survive canonical writes untouched.
  const knownUnpinnedKeys = new Set(input.rows.filter((row) => !row.pinned).map((row) => row.key));
  const reconciled = reconcileSidebarZone(
    input.sidebarEntries,
    pinnedRows,
    SIDEBAR_NAV_ROUTES,
    knownUnpinnedKeys,
    new Set([...pluginTabs.keys(), ...navigation.map((entry) => entry.key)]),
    defaultPluginNavigationKeys,
  );
  return {
    ...reconciled,
    sessionRows: new Map(pinnedRows.map((row) => [row.key, row])),
    pluginTabs,
    defaultPluginNavigationKeys,
  };
}

type SidebarSessionSelection = {
  selectedKeys: ReadonlySet<string>;
  anchor: string | null;
};

export function toggleSidebarSessionSelection(
  selectedKeys: ReadonlySet<string>,
  key: string,
): SidebarSessionSelection {
  const next = new Set(selectedKeys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return { selectedKeys: next, anchor: next.has(key) ? key : null };
}

export function extendSidebarSessionSelection(input: {
  rows: readonly SidebarRecentSession[];
  anchor: string | null;
  key: string;
}): SidebarSessionSelection {
  const anchor =
    input.anchor ?? input.rows.find((row) => row.visuallyActive || row.active)?.key ?? input.key;
  const anchorIndex = input.rows.findIndex((row) => row.key === anchor);
  const targetIndex = input.rows.findIndex((row) => row.key === input.key);
  if (anchorIndex === -1 || targetIndex === -1) {
    return { selectedKeys: new Set([input.key]), anchor: input.key };
  }
  const [start, end] =
    anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return {
    selectedKeys: new Set(input.rows.slice(start, end + 1).map((row) => row.key)),
    anchor,
  };
}

function latestVisibleAgentSessionRow(input: {
  agentId: string;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  sessionResultsByAgent: Readonly<Record<string, SessionsListResult>>;
  defaultAgentId: string;
}): SessionRow | null {
  const normalized = normalizeAgentId(input.agentId);
  const rows =
    normalized === normalizeAgentId(input.sessionsAgentId ?? "")
      ? (input.sessionsResult?.sessions ?? [])
      : (input.sessionResultsByAgent[normalized]?.sessions ?? []);
  // Unprefixed keys belong to the system default agent. Keeping them for
  // another agent would resume the wrong conversation with the raw key.
  const visible = filterVisibleSessionRows(rows, {
    agentId: normalized,
    defaultAgentId: input.defaultAgentId,
    filterByAgent: true,
    archivedFilter: "active",
  });
  return visible.reduce<SessionRow | null>(
    (latest, row) =>
      latest !== null && compareSessionRowsByUpdatedAt(latest, row) <= 0 ? latest : row,
    null,
  );
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
  sessionData: {
    sessionsAgentId: string | null;
    sessionsResult: SessionsListResult | null;
    sessionResultsByAgent: Readonly<Record<string, SessionsListResult>>;
  };
  context: ApplicationContext | undefined;
}): SessionRow | null {
  return latestVisibleAgentSessionRow({
    agentId: input.agentId,
    sessionsAgentId: input.sessionData.sessionsAgentId,
    sessionsResult: input.sessionData.sessionsResult,
    sessionResultsByAgent: input.sessionData.sessionResultsByAgent,
    defaultAgentId: resolveUiDefaultAgentId({
      agentsList: input.context?.agents.state.agentsList,
      hello: input.context?.gateway.snapshot.hello,
    }),
  });
}

export function collectSidebarSessionRowsByKey(input: {
  rows: readonly GatewaySessionRow[];
  childRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
}): ReadonlyMap<string, GatewaySessionRow> {
  const rowsByKey = new Map<string, GatewaySessionRow>();
  for (const rows of Object.values(input.childRowsByParent)) {
    for (const row of rows) {
      rowsByKey.set(row.key, row);
    }
  }
  for (const row of input.rows) {
    rowsByKey.set(row.key, row);
  }
  return rowsByKey;
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
      normalizeOptionalString(row.category) != null &&
      resolveUiSessionNavigationParentKey(row) != null &&
      sessionMatchesVisibleSessionScope(row, input.visibilityOptions),
  );
}

export function resolveSidebarAgentResumeKey(
  latest: SessionRow | null,
  agentId: string,
  mainKey: string,
): string {
  return latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey });
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

export function findSidebarMainSessionRow(
  rows: readonly GatewaySessionRow[],
  mainKey: string,
): GatewaySessionRow | null {
  return rows.find((row) => areUiSessionKeysEquivalent(row.key, mainKey)) ?? null;
}

export function collectKnownSidebarSessionGroups(
  catalog: readonly string[],
  rows: readonly GatewaySessionRow[],
): string[] {
  return collectKnownSessionGroups(catalog, rows);
}

/** Depth-first search across a projected session tree, including descendants.
 *  Both callers ask "does any row match", so this short-circuits rather than
 *  flattening: the answer usually resolves in the first few rows. */
export function someSidebarSessionInTree(
  roots: readonly SidebarRecentSession[],
  predicate: (row: SidebarRecentSession) => boolean,
): boolean {
  const pending = [...roots];
  while (pending.length > 0) {
    const row = pending.pop();
    if (row) {
      if (predicate(row)) {
        return true;
      }
      pending.push(...row.children);
    }
  }
  return false;
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
