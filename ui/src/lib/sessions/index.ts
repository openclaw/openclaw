import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import type { SessionCreateOutcome } from "./create.ts";
import type { SessionChangedResult, SessionReconcileOptions } from "./reconcile.ts";
import type { SessionCapability, SessionGateway, SessionState } from "./session-capability.ts";
import { createSessionDeletions } from "./session-deletions.ts";
import { createSessionEventSubscriptionOwner } from "./session-event-subscription.ts";
import { createSessionGitHubPublication } from "./session-github-publication.ts";
import { createSessionGroupCatalog } from "./session-group-catalog.ts";
import { normalizeAgentId, parseAgentSessionKey, uiSessionEventMatches } from "./session-key.ts";
import { createSessionMutations } from "./session-mutations.ts";
import { createSessionPermissionProjection } from "./session-permission-projection.ts";
import { createSessionReconciliation } from "./session-reconciliation.ts";
import { sessionRetryDelayMs } from "./session-retry.ts";
import { createSessionRosterCacheLifecycle } from "./session-roster-cache-lifecycle.ts";
import type { SessionRosterCacheOptions } from "./session-roster-cache.ts";
import { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import type { SessionRunTerminal } from "./session-run-terminal.ts";
import { createSessionScopedOperations } from "./session-scoped-operations.ts";
import { createSessionThinkingClaims } from "./session-thinking-claims.ts";
import { SwarmActivityTracker } from "./swarm-activity.ts";

export type { SessionArchivedFilter } from "./navigation.ts";
export type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
  SessionRowObservation,
  SessionRowTarget,
  SessionMessageSubscription,
} from "./session-capability.ts";
export type { SessionPatch, SessionPatchResult } from "./patch.ts";
export { DEFAULT_SESSION_LIST_QUERY, SESSIONS_PAGE_DEFAULT_LIMIT } from "./session-requests.ts";
export { reconcileSessionRunTerminal, type SessionRunTerminal } from "./session-run-terminal.ts";
export { resolveSessionKey } from "./navigation.ts";
export {
  compareSessionRowsByUpdatedAt,
  filterSessionRows,
  filterVisibleSessionRows,
  getVisibleSessionRows,
  isSystemCreatedSessionRow,
  resolveSessionNavigation,
  sessionMatchesArchivedFilter,
  sessionMatchesVisibleSessionScope,
  scopedAgentIdForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";
export type {
  SessionRefreshTarget,
  SessionScopeHost,
  SessionScopeHostWithKey,
} from "./navigation.ts";

type SessionAgentSelection = {
  readonly state: { readonly selectedId: string | null };
  subscribe: (listener: () => void) => () => void;
};

export function createSessionCapability(
  gateway: SessionGateway,
  agentSelection: SessionAgentSelection,
  cacheOptions: SessionRosterCacheOptions = {},
): SessionCapability {
  let state: SessionState = {
    result: null,
    agentId: null,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: cacheOptions.bootRecord?.groups.map((group) => group.name) ?? [],
    groupSettings: cacheOptions.bootRecord?.groups ?? [],
    sectionOrder: cacheOptions.bootRecord?.sectionOrder ?? [],
  };
  const cacheLifecycle = createSessionRosterCacheLifecycle(gateway, agentSelection, cacheOptions, {
    readState: () => state,
    publish: (next) => publish(next),
    connected: () => connection.capture() !== null,
    query: () => roster.lastOptions(),
  });

  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  const githubPublication = createSessionGitHubPublication({
    connection,
    snapshot: () => gateway.snapshot,
    deletionState: (row) => deletions.deletionState(row.key, row.agentId, row.sessionId),
  });
  const swarmActivity = new SwarmActivityTracker();
  const pullRequestSummaries = new Map<string, SessionCatalogPullRequestSummary>();
  const pullRequestEpochs = new Map<string, object>();
  const listeners = new Set<(next: SessionState) => void>();
  const createdListeners = new Set<(key: string) => void>();
  const thinkingClaims = createSessionThinkingClaims(gateway, () => roster.requestRevision);
  let canonicalListRevision = 0;
  let hydratedClient: SessionGateway["snapshot"]["client"] = null;
  let hydratedSelfUserId: string | null = null;
  let connectionClient = gateway.snapshot.client;
  let selectedAgentId = agentSelection.state.selectedId;
  let sessionEventSubscriptionError: string | null = null;
  let publishedErrorSource: "session-observer" | "operation" | null = null;

  const publish = (next: SessionState, errorSource?: "session-observer" | "operation") => {
    if (next.error === null) {
      publishedErrorSource = null;
    } else if (errorSource || next.error !== state.error) {
      publishedErrorSource = errorSource ?? "operation";
    }
    roster.bindOwner(next.result, next.agentId);
    state = next;
    githubPublication.observeRows(next.result?.sessions ?? [], next.agentId);
    cacheLifecycle.persist(next);
    for (const listener of listeners) {
      listener(state);
    }
  };

  const retirePullRequestSummary = (key: string) => {
    const normalizedKey = key.trim();
    pullRequestEpochs.delete(normalizedKey);
    pullRequestSummaries.delete(normalizedKey);
  };

  // Canonical Gateway rows are the source of truth for everything except the
  // UI-owned facts the capability keeps beside them, so every published result
  // passes through the same overlay: swarm notes, then in-flight row intents.
  const decorateRows = (
    result: SessionsListResult | null,
    owner = roster.primaryList(),
  ): SessionsListResult | null => {
    // Row selection cannot undo a newer field fact; pending local choices apply last.
    const projected = permissions.apply(result, roster.rowRevision, owner.scope.agentId);
    const annotated = swarmActivity.decorate(projected);
    // Preserve receipts before a pending intent makes another tracked copy.
    roster.inherit(annotated, projected);
    const decorated = deletions.apply(
      mutations.applyConfirmedArchives(mutations.applyPendingRows(annotated, owner.scope.agentId)),
      owner,
    );
    roster.inherit(decorated, result);
    return decorated;
  };

  const sessionEventSubscription = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => connection.isCurrent(scope),
    retryDelayMs: sessionRetryDelayMs,
    onError: (scope, error) => {
      if (!connection.isCurrent(scope)) {
        return;
      }
      const previousError = sessionEventSubscriptionError;
      sessionEventSubscriptionError = error;
      const observerOwnsVisibleError = publishedErrorSource === "session-observer";
      if (error !== null && (state.error === null || observerOwnsVisibleError)) {
        publish({ ...state, error }, "session-observer");
      } else if (error === null && observerOwnsVisibleError) {
        publish({ ...state, error: null });
      }
      if (previousError !== null && error === null) {
        // Observer outages do not replay events; every held query must close the gap.
        void roster.refresh({ ...roster.lastOptions(), backgroundHydrate: true, force: true });
        roster.invalidateManagedLists();
      }
    },
  });

  const permissions = createSessionPermissionProjection(gateway, () => roster);

  const roster = createSessionRosterRefresh({
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    observerError: () => sessionEventSubscriptionError,
    bootstrap: (scope, list) => sessionEventSubscription.ensure(scope, list),
    decorate: decorateRows,
    reconcileList: (result, revision, agentId) => {
      const admitted = deletions.reconcileList(result, revision, agentId);
      const sources =
        admitted?.sessions.map((row) => ({
          row,
          select: roster.observeReadRow(row, revision, agentId),
        })) ?? [];
      const projected = permissions.reconcileList(admitted, revision, agentId);
      roster.inherit(projected, admitted);
      if (!projected) {
        return projected;
      }
      const sessions = roster.projectRows(projected.sessions);
      sessions.forEach((row, index) => {
        const source = sources[index];
        if (source) {
          mutations.observePendingFields(
            source.row,
            source.select(row, ["pinned", "pinnedAt", "unread"]),
            agentId,
          );
        }
      });
      return projected;
    },
    onCanonicalList(result, requestRevision, agentId, observed) {
      githubPublication.observeRows(observed?.sessions ?? result?.sessions ?? [], agentId);
      mutations.settlePrepared(result);
      for (const row of observed?.sessions ?? []) {
        thinkingClaims.settle(row, requestRevision, agentId);
      }
      canonicalListRevision += 1;
    },
  });

  const groups = createSessionGroupCatalog({
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    refreshRows: () => roster.refresh({ ...roster.lastOptions(), force: true }),
    retryDelayMs: sessionRetryDelayMs,
  });

  const notifyCreated = (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => {
    thinkingClaims.recordCreated(key, entry, agentId);
    for (const listener of createdListeners) {
      listener(key);
    }
  };

  const mutations = createSessionMutations({
    connection,
    snapshot: () => gateway.snapshot,
    findRow: (matches) => {
      const row = roster.publishedRow(matches);
      return row ? roster.projectFields(row) : undefined;
    },
    readState: () => state,
    publish,
    copyRow: roster.copyRow,
    refreshReplacement: roster.refreshReplacement,
    refreshReplacementResult: roster.refreshReplacementResult,
    publishedRow: (key) => roster.publishedRow((row) => row.key === key),
    redecorateLists: () => roster.redecorateLists(),
    notifyCreated,
    clearThink: thinkingClaims.clear,
    claimPermissionProjection: permissions.claim,
    capturePatchFields: (target) => capturePatchFields(target),
    retirePullRequestSummary,
  });

  const deletions = createSessionDeletions({
    connection,
    snapshot: () => gateway.snapshot,
    requestRevision: () => roster.requestRevision,
    readState: () => state,
    publish,
    publishedRow: (matches) => roster.publishedRow(matches),
    redecorateLists: () => roster.redecorateLists(),
    invalidateLists: () => roster.scheduleEvent(),
    refreshReplacement: roster.refreshReplacement,
    reconcilePreviousConnection: mutations.reconcileConfirmedPreviousConnection,
    retire: mutations.retireDeletedSession,
  });

  const operations = createSessionScopedOperations({
    connection,
    agentId: () => state.agentId,
    refreshReplacement: roster.refreshReplacement,
    notifyCreated,
    reportError: (error) => publish({ ...state, error: formatUiError(error) }, "operation"),
  });

  const pullRequestSummary = (key: string) => pullRequestSummaries.get(key.trim());

  const capturePullRequestEpoch = (key: string): object => {
    const epoch = {};
    pullRequestEpochs.set(key.trim(), epoch);
    return epoch;
  };

  const setPullRequestSummary = (
    key: string,
    summary: SessionCatalogPullRequestSummary | undefined,
    epoch?: object,
  ) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || (epoch !== undefined && pullRequestEpochs.get(normalizedKey) !== epoch)) {
      return;
    }
    if (pullRequestSummaries.get(normalizedKey) === summary) {
      return;
    }
    if (summary) {
      pullRequestSummaries.set(normalizedKey, summary);
    } else {
      pullRequestSummaries.delete(normalizedKey);
    }
    publish({ ...state });
  };

  const { reconcile, captureReconcile, capturePatchFields, reconcileChangedEvent, observeRow } =
    createSessionReconciliation({
      readState: () => state,
      publish,
      canonicalListRevision: () => canonicalListRevision,
      connection,
      snapshot: () => gateway.snapshot,
      permissions,
      mutations,
      thinkingClaims,
      decorate: decorateRows,
      deletions,
      githubPublication,
      roster,
    });

  const publishReconciledState = (next: SessionState) => {
    const operationOwnsError = publishedErrorSource === "operation";
    const error = operationOwnsError ? state.error : sessionEventSubscriptionError;
    publish(
      { ...next, error },
      error === null ? undefined : operationOwnsError ? "operation" : "session-observer",
    );
  };

  const reconcileChanged = (
    payload: unknown,
    options?: SessionReconcileOptions,
  ): SessionChangedResult => {
    const eventObservation = roster.captureEvent(payload);
    const {
      reconciled: base,
      claimChanged,
      notifyManaged,
    } = reconcileChangedEvent(payload, options, eventObservation);
    const result = decorateRows(base.result);
    const reconciled =
      result === base.result
        ? base
        : {
            ...base,
            result,
            row: base.row ? result?.sessions.find((row) => row.key === base.row?.key) : undefined,
          };
    let primaryPublished = false;
    if (
      claimChanged ||
      (reconciled.applied && (reconciled.result !== state.result || reconciled.deletedKey))
    ) {
      publishReconciledState({
        ...state,
        result: reconciled.result,
        agentId: options?.resultAgentId?.trim()
          ? normalizeAgentId(options.resultAgentId)
          : state.agentId,
      });
      primaryPublished = true;
    }
    notifyManaged?.(primaryPublished);
    if (eventObservation.scope && !connection.isCurrent(eventObservation.scope)) {
      return { applied: false, result: state.result };
    }
    return reconciled;
  };

  const reconcileRunTerminal = (terminal: SessionRunTerminal): boolean => {
    const event = roster.captureEvent(terminal);
    if (event.scope && !connection.isCurrent(event.scope)) {
      return false;
    }
    for (const key of terminal.sessionKeys) {
      if (key.trim()) {
        roster.invalidateManagedLists(parseAgentSessionKey(key)?.agentId ?? terminal.agentId);
      }
    }
    const previous = state.result;
    const { result, changed, notify } = roster.stageRunTerminal(terminal, event);
    if (result !== previous) {
      publishReconciledState({ ...state, result });
    }
    notify();
    return changed;
  };

  const stopGateway = gateway.subscribe((next) => {
    const previousClient = connectionClient;
    const connected = next.phase === "connected";
    const selfUserId = next.selfUser?.id.trim() || null;
    const connectionChanged = connection.transition(next);
    roster.observeGateway(next, connectionChanged);
    cacheLifecycle.synchronize(next);
    connectionClient = next.client;
    githubPublication.observeRows([]);
    if (connectionChanged) {
      if (previousClient !== next.client) {
        deletions.clear();
      }
      const hadPullRequestSummaries = pullRequestSummaries.size > 0;
      thinkingClaims.reset();
      permissions.clear();
      roster.reset();
      sessionEventSubscription.reset();
      sessionEventSubscriptionError = null;
      operations.retireConnection(previousClient);
      groups.invalidate();
      swarmActivity.clear();
      mutations.retireConnection();
      pullRequestSummaries.clear();
      pullRequestEpochs.clear();
      // Client replacement needs a publish; disconnect publishes cleared state below.
      if (hadPullRequestSummaries && connected && next.client) {
        publish({ ...state });
      }
    }
    if (!connected || !next.client) {
      hydratedClient = null;
      hydratedSelfUserId = null;
      publish({
        ...state,
        result: state.resultCached ? state.result : null,
        agentId: state.resultCached ? state.agentId : null,
        loading: false,
        error: null,
        deletedSessions: [],
      });
      return;
    }
    const hydrateConnection = hydratedClient !== next.client;
    if (hydrateConnection || hydratedSelfUserId !== selfUserId) {
      const scope = connection.capture();
      if (!scope) {
        return;
      }
      hydratedClient = scope.client;
      hydratedSelfUserId = selfUserId;
      if (!hydrateConnection) {
        // Identity updates refresh the current roster without displacing queued picker intent.
        roster.scheduleEvent();
        return;
      }
      const hydrate = async () => {
        if (connection.isCurrent(scope)) {
          await roster.bootstrap({
            ...roster.lastOptions(), // Keep visible roster filters through reconnect hydration.
            agentId: agentSelection.state.selectedId ?? undefined,
            includeDerivedTitles: true,
            includeLastMessage: true,
            backgroundHydrate: true,
            force: true,
          });
          if (connection.isCurrent(scope)) {
            await roster.refreshManagedLists();
          }
        }
      };
      void hydrate().catch(() => undefined);
    }
  });

  const stopSelection = agentSelection.subscribe(() => {
    const nextAgentId = agentSelection.state.selectedId;
    if (selectedAgentId === nextAgentId) {
      return;
    }
    selectedAgentId = nextAgentId;
    // Selection publishes before Gateway hydration. A new connection bootstraps
    // the current selection; route changes on a hydrated connection replace its roster.
    if (nextAgentId && hydratedClient === gateway.snapshot.client) {
      void roster.refreshReplacement(nextAgentId);
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event !== "sessions.changed" && event.event !== "session.message") {
      return;
    }
    const eventObservation = roster.captureEvent(event.payload);
    const swarmChanged = swarmActivity.observe(event.payload);
    const { eventInfo, reconciled, claimChanged, notifyManaged } = reconcileChangedEvent(
      event.payload,
      { resultAgentId: state.agentId, archivedFilter: roster.lastOptions().archivedFilter },
      eventObservation,
    );
    if (eventObservation.scope && !connection.isCurrent(eventObservation.scope)) {
      return;
    }
    const payload = event.payload as {
      agentId?: unknown;
      reason?: unknown;
      session?: unknown;
    } | null;
    const hasActiveRun = reconciled.hasActiveRun ?? eventInfo?.hasActiveRun;
    const status = reconciled.status ?? eventInfo?.status;
    const runEnded =
      hasActiveRun === false || (status !== null && status !== undefined && status !== "running");
    const isTerminalMessage = event.event === "session.message" && runEnded;
    // Only an existing Gateway roster member that remains active can be replaced directly.
    const primarySnapshotApplied =
      isTerminalMessage &&
      reconciled.applied &&
      eventInfo !== null &&
      eventInfo.archived !== true &&
      typeof payload?.session === "object" &&
      payload.session !== null &&
      roster.canApplyPrimarySnapshot() &&
      state.result?.sessions.some((row) =>
        uiSessionEventMatches(
          { ...gateway.snapshot, sessionKey: row.key },
          eventInfo.key,
          eventInfo.agentId,
        ),
      ) === true;
    let primaryPublished = false;
    if (
      claimChanged ||
      swarmChanged ||
      (eventInfo?.archived !== null && !isTerminalMessage) ||
      primarySnapshotApplied
    ) {
      const result = decorateRows(reconciled.result);
      if (claimChanged || result !== state.result) {
        publishReconciledState({ ...state, result });
        primaryPublished = true;
      }
    }
    notifyManaged?.(primaryPublished);
    if (eventObservation.scope && !connection.isCurrent(eventObservation.scope)) {
      return;
    }
    const eventReason = payload?.reason;
    const payloadAgentId = payload?.agentId;
    if (eventReason === "groups") {
      groups.invalidate();
      void groups.load();
    }
    if (event.event === "session.message" && !runEnded) {
      return;
    }
    roster.scheduleEvent({
      agentId:
        eventInfo?.agentId ??
        parseAgentSessionKey(eventInfo?.key)?.agentId ??
        (typeof payloadAgentId === "string" ? payloadAgentId : undefined),
      primarySnapshotApplied,
    });
  });

  return {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    githubPublication,
    whenCachedRosterSettled: () => cacheLifecycle.settled,
    captureConnectionScope: () => connection.capture(),
    isConnectionScopeCurrent: (scope) => connection.isCurrent(scope),
    list: roster.list,
    observeList: roster.observeList,
    listSnapshot: (scope) => roster.listSnapshot(scope),
    subscribeList(scope, listener) {
      if (!roster.isPrimaryList(scope)) {
        return roster.subscribeList(scope, listener);
      }
      const notify = () => listener(roster.listSnapshot(scope));
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    refreshList: (options) => roster.refreshList(options),
    reconcile,
    captureReconcile,
    observeRow,
    inheritRow: roster.inheritRow,
    projectRows: roster.projectRows,
    reconcileChanged,
    reconcileRunTerminal,
    refresh: roster.refresh,
    refreshReplacement: roster.refreshReplacement,
    createResult: mutations.createResult,
    create: mutations.create,
    recover: operations.recover,
    patch: mutations.patch,
    archiveVisibility: mutations.archiveVisibility,
    setArchivePending: mutations.setArchivePending,
    assignOwner: mutations.assignOwner,
    retireModelOverride: mutations.retireModelOverride,
    think: thinkingClaims.get,
    patchRowLocal: mutations.patchRowLocal,
    isPreparedWorkSession: mutations.isPreparedWorkSession,
    pullRequestSummary,
    capturePullRequestEpoch,
    setPullRequestSummary,
    delete: deletions.delete,
    deleteMany: deletions.deleteMany,
    deletionState: deletions.deletionState,
    reset: mutations.reset,
    compact: operations.compact,
    listFiles: operations.listFiles,
    getFile: operations.getFile,
    setFile: operations.setFile,
    subscribeMessages: operations.subscribeMessages,
    unsubscribeMessages: operations.unsubscribeMessages,
    listCheckpoints: operations.listCheckpoints,
    branchCheckpoint: operations.branchCheckpoint,
    restoreCheckpoint: operations.restoreCheckpoint,
    rewind: operations.rewind,
    forkAtMessage: operations.forkAtMessage,
    listBranches: operations.listBranches,
    switchBranch: operations.switchBranch,
    groupsLoad: groups.load,
    groupsGeneration: groups.generation,
    groupsStatus: groups.status,
    groupsInvalidate: groups.invalidate,
    groupsPut: groups.put,
    groupsRename: groups.rename,
    groupsUpdate: groups.update,
    groupsDelete: groups.delete,
    subscribeCreated(listener) {
      createdListeners.add(listener);
      return () => createdListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      cacheLifecycle.dispose();
      githubPublication.clear();
      roster.dispose();
      operations.dispose();
      connection.dispose();
      groups.dispose();
      hydratedClient = null;
      hydratedSelfUserId = null;
      mutations.dispose();
      permissions.clear();
      deletions.clear();
      swarmActivity.clear();
      pullRequestSummaries.clear();
      pullRequestEpochs.clear();
      sessionEventSubscription.dispose();
      stopGateway();
      stopSelection();
      stopEvents();
      createdListeners.clear();
      listeners.clear();
    },
  };
}
