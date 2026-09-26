import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import type { SessionCreateOutcome } from "./create.ts";
import { subscribeAgentSelection, type SessionAgentSelection } from "./session-agent-selection.ts";
import type { SessionCapability, SessionGateway, SessionState } from "./session-capability.ts";
import { createSessionDeletions } from "./session-deletions.ts";
import { createSessionEventSubscriptionOwner } from "./session-event-subscription.ts";
import { createSessionGitHubPublication } from "./session-github-publication.ts";
import { createSessionGroupCatalog } from "./session-group-catalog.ts";
import { normalizeAgentId, parseAgentSessionKey } from "./session-key.ts";
import { createSessionMutations } from "./session-mutations.ts";
import { optimisticSessionRowFields } from "./session-pending-rows.ts";
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

export function createSessionCapability(
  gateway: SessionGateway,
  agentSelection: SessionAgentSelection,
  cacheOptions: SessionRosterCacheOptions & {
    connectionBootstrap?: ConnectionBootstrapCoordinator;
  } = {},
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
  let presentation: SessionCapability["presentation"] = { result: null, agentId: null };
  let reconnectListRevision: number | null = null;
  let presentationProfileId =
    gateway.snapshot.phase === "connected"
      ? (gateway.snapshot.selfUser?.id.trim() ?? null)
      : cacheOptions.bootRecord?.profileId;
  const retirePresentation = () => {
    if (presentation.result || state.result || reconnectListRevision !== null) {
      reconnectListRevision = canonicalListRevision + 1;
    }
    presentation = { result: null, agentId: null };
  };
  const cacheLifecycle = createSessionRosterCacheLifecycle(gateway, agentSelection, cacheOptions, {
    readState: () => state,
    publish: (next) => {
      // Cache admission and retirement already own credential/profile boundaries.
      roster.retireWarmLists();
      retirePresentation();
      if (next.resultCached) {
        presentation = { result: next.result, agentId: next.agentId, resultCached: true };
      }
      publish(next);
    },
    connected: () => connection.capture() !== null,
    query: () => roster.lastOptions(),
  });

  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  const background = async (key: string | object, task: () => Promise<unknown>): Promise<void> => {
    const scope = connection.capture();
    const run = async () => {
      if (scope && connection.isCurrent(scope) && gateway.snapshot.client === scope.client) {
        await task();
      }
    };
    await (cacheOptions.connectionBootstrap?.run(key, run, { background: true }) ?? run());
  };
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
  let sessionEventSubscriptionError: string | null = null;
  let publishedErrorSource: "session-observer" | "operation" | null = null;

  const notifySubscribers = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  const publish = (next: SessionState, errorSource?: "session-observer" | "operation") => {
    if (next.error === null) {
      publishedErrorSource = null;
    } else if (errorSource || next.error !== state.error) {
      publishedErrorSource = errorSource ?? "operation";
    }
    roster.observations.bindOwner(next.result, next.agentId);
    state = next;
    if (reconnectListRevision === null || canonicalListRevision >= reconnectListRevision) {
      presentation = {
        result: next.result,
        agentId: next.agentId,
        resultCached: next.resultCached,
      };
      if (!next.resultCached) {
        reconnectListRevision = null;
      }
    }
    githubPublication.observeRows(next.result?.sessions ?? [], next.agentId);
    cacheLifecycle.persist(next);
    notifySubscribers();
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
    const projected = permissions.apply(
      result,
      roster.observations.rowRevision,
      owner.scope.agentId,
    );
    const annotated = swarmActivity.decorate(projected);
    // Preserve receipts before a pending intent makes another tracked copy.
    roster.observations.inherit(annotated, projected);
    const decorated = deletions.apply(
      mutations.applyPendingRows(mutations.applyConfirmedArchives(annotated), owner.scope.agentId),
      owner,
    );
    roster.observations.inherit(decorated, result);
    return decorated;
  };

  const sessionEventSubscription = createSessionEventSubscriptionOwner({
    isCurrent: connection.isCurrent,
    retryDelayMs: sessionRetryDelayMs,
    onError: (scope, error) => {
      if (!connection.isCurrent(scope)) {
        return;
      }
      const previousError = sessionEventSubscriptionError;
      sessionEventSubscriptionError = error;
      if (error !== null) {
        roster.retireWarmLists();
      }
      const observerOwnsVisibleError = publishedErrorSource === "session-observer";
      if (error !== null && (state.error === null || observerOwnsVisibleError)) {
        publish({ ...state, error }, "session-observer");
      } else if (error === null && observerOwnsVisibleError) {
        publish({ ...state, error: null });
      }
      if (previousError !== null && error === null) {
        // Observer outages do not replay events; every held query must close the gap.
        githubPublication.invalidate();
        void roster.refreshAutomatic({
          ...roster.lastOptions(),
          backgroundHydrate: true,
          force: true,
        });
        roster.invalidateManagedLists();
      }
    },
  });

  const permissions = createSessionPermissionProjection(gateway, () => roster);

  const roster = createSessionRosterRefresh({
    background,
    connection,
    snapshot: () => gateway.snapshot,
    readState: () => state,
    publish,
    onWarmListsRetired: (agentIds) => {
      const selectedId = agentSelection.state.selectedId;
      if (!presentation.result && selectedId && agentIds.has(normalizeAgentId(selectedId))) {
        notifySubscribers();
      }
    },
    observerError: () => sessionEventSubscriptionError,
    decorate: decorateRows,
    reconcileList: (result, revision, agentId) => {
      const admitted = deletions.reconcileList(result, revision, agentId);
      const sources = roster.observations.observeReadRows(
        admitted?.sessions ?? [],
        revision,
        agentId,
      );
      const projected = permissions.reconcileList(admitted, revision, agentId);
      roster.observations.inherit(projected, admitted);
      if (!projected) {
        return projected;
      }
      const sessions = roster.observations.projectRows(projected.sessions);
      sessions.forEach((row, index) => {
        const source = sources[index];
        if (source) {
          mutations.observePendingFields(
            source.row,
            source.select(row, optimisticSessionRowFields),
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
    roster.retireWarmLists();
    thinkingClaims.recordCreated(key, entry, agentId);
    for (const listener of createdListeners) {
      listener(key);
    }
  };

  const publishMutation: typeof publish = (next, errorSource) => {
    // A local mutation can complete without an event or successful refresh.
    // Retire inactive windows before exposing its publication to selection.
    roster.retireWarmLists();
    publish(next, errorSource);
  };

  const mutations = createSessionMutations({
    connection,
    snapshot: () => gateway.snapshot,
    findRow: (matches) => {
      const row = roster.observations.publishedRow(matches);
      return row ? roster.observations.projectFields(row) : undefined;
    },
    readState: () => state,
    publish: publishMutation,
    copyRow: roster.observations.copyRow,
    stageManagedResults: roster.observations.stageManagedResults,
    reconcileMutation: roster.reconcileMutation,
    publishedRow: (key) => roster.observations.publishedRow((row) => row.key === key),
    archiveFields: roster.observations,
    readRevision: () => roster.requestRevision,
    redecorateLists: roster.redecorateLists,
    notifyPendingChange: notifySubscribers,
    notifyCreated,
    clearThink: thinkingClaims.clear,
    suspendThink: thinkingClaims.suspend,
    claimPermissionProjection: permissions.claim,
    capturePatchFields: (target) => capturePatchFields(target),
    retirePullRequestSummary,
  });

  const deletions = createSessionDeletions({
    connection,
    snapshot: () => gateway.snapshot,
    requestRevision: () => roster.requestRevision,
    readState: () => state,
    publish: publishMutation,
    publishedRow: roster.observations.publishedRow,
    redecorateLists: roster.redecorateLists,
    invalidateLists: roster.scheduleEvent,
    reconcileMutation: roster.reconcileMutation,
    reconcilePreviousConnection: mutations.reconcileConfirmedPreviousConnection,
    retire: mutations.retireDeletedSession,
  });

  const {
    dispose: disposeOperations,
    retireConnection: retireOperationConnection,
    ...operations
  } = createSessionScopedOperations({
    connection,
    reconcileMutation: roster.reconcileMutation,
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

  const reconcileRunTerminal = (terminal: SessionRunTerminal): boolean => {
    const captured = roster.captureReconciliation();
    if (captured.scope && !connection.isCurrent(captured.scope)) {
      return false;
    }
    for (const key of terminal.sessionKeys) {
      if (key.trim()) {
        roster.invalidateManagedLists(parseAgentSessionKey(key)?.agentId ?? terminal.agentId, {
          key,
        });
      }
    }
    const previous = state.result;
    const { result, changed, notify } = roster.observations.stageRunTerminal(terminal, captured);
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
    if (connected) {
      if (presentationProfileId !== undefined && presentationProfileId !== selfUserId) {
        roster.retireWarmLists();
        retirePresentation();
        notifySubscribers();
      }
      presentationProfileId = selfUserId;
    } else if (!next.client) {
      retirePresentation();
    } else if (presentation.result && reconnectListRevision === null) {
      // Keep the paired presentation through partial startup reads until the canonical list lands.
      reconnectListRevision = canonicalListRevision + 1;
    }
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
      retireOperationConnection(previousClient);
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
      // Register events before delaying bulk metadata; its later read reconciles
      // anything observed while the selected transcript was loading.
      void sessionEventSubscription.ensure(scope);
      void roster
        .bootstrap({
          ...roster.lastOptions(), // Keep visible roster filters through reconnect hydration.
          agentId: agentSelection.state.selectedId ?? undefined,
          includeDerivedTitles: true,
          includeLastMessage: true,
          backgroundHydrate: true,
          force: true,
        })
        .then(() => {
          if (connection.isCurrent(scope)) {
            // Child jobs own their own slots; never wait for them inside a scheduler slot.
            void roster.refreshManagedLists();
          }
        })
        .catch(() => undefined);
    }
  });

  const stopSelection = subscribeAgentSelection(agentSelection, (nextAgentId, foreground) => {
    retirePresentation();
    notifySubscribers();
    // Selection publishes before Gateway hydration. A new connection bootstraps
    // the current selection; route changes on a hydrated connection replace its roster.
    if (nextAgentId && hydratedClient === gateway.snapshot.client) {
      void roster.refreshSelection(() => agentSelection.state.selectedId, foreground);
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event === "config.changed") {
      // Config can change configured-agent membership even with no chat pane mounted.
      roster.scheduleEvent();
      return;
    }
    if (event.event !== "sessions.changed" && event.event !== "session.message") {
      return;
    }
    const payload = event.payload as {
      agentId?: unknown;
      reason?: unknown;
      session?: unknown;
    } | null;
    // Recaps are opt-in Activity data; shared session queries never include them.
    if (event.event === "sessions.changed" && payload?.reason === "activity-summary") {
      roster.captureEvent(event.payload).deliver(event);
      return;
    }
    const canApplySnapshot = roster.canApplyPrimarySnapshot(event.payload);
    const eventObservation = roster.captureEvent(event.payload);
    const swarmChanged = swarmActivity.observe(event.payload);
    const { eventInfo, reconciled, claimChanged, notifyManaged, notifyEvent } =
      reconcileChangedEvent(event.payload, eventObservation, {
        resultAgentId: state.agentId,
        archivedFilter: roster.lastOptions().archivedFilter,
      });
    if (eventObservation.scope && !connection.isCurrent(eventObservation.scope)) {
      return;
    }
    const hasActiveRun = reconciled.hasActiveRun ?? eventInfo?.hasActiveRun;
    const status = reconciled.status ?? eventInfo?.status;
    const runEnded =
      hasActiveRun === false || (status !== null && status !== undefined && status !== "running");
    const isTerminalMessage = event.event === "session.message" && runEnded;
    const primarySnapshotApplied = reconciled.applied && canApplySnapshot;
    let primaryPublished = false;
    if (
      claimChanged ||
      swarmChanged ||
      (eventInfo?.archived !== null && !isTerminalMessage) ||
      (!isTerminalMessage &&
        reconciled.applied &&
        (reconciled.result !== state.result || reconciled.deletedKey)) ||
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
      void background(groups.load, () => groups.load());
    }
    if (event.event === "session.message" && !runEnded) {
      notifyEvent?.(event);
      return;
    }
    roster.scheduleEvent({
      agentId:
        eventInfo?.agentId ??
        parseAgentSessionKey(eventInfo?.key)?.agentId ??
        (typeof payloadAgentId === "string" ? payloadAgentId : undefined),
      primarySnapshotApplied,
      affectsPrimary: eventObservation.affectsPrimary,
      affectedLists: eventObservation.lists,
    });
    notifyEvent?.(event);
  });

  return {
    get state() {
      return state;
    },
    get presentation() {
      return presentation.result
        ? presentation
        : (roster.selectionPresentation(agentSelection.state.selectedId) ?? presentation);
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    githubPublication,
    whenCachedRosterSettled: () => cacheLifecycle.settled,
    captureConnectionScope: connection.capture,
    isConnectionScopeCurrent: connection.isCurrent,
    list: roster.list,
    observeList: roster.observeList,
    listSnapshot: roster.listSnapshot,
    subscribeList(scope, listener) {
      if (!roster.isPrimaryList(scope)) {
        return roster.subscribeList(scope, listener);
      }
      const notify = () => listener(roster.listSnapshot(scope));
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    refreshList: roster.refreshList,
    reconcile,
    captureReconcile,
    observeRow,
    inheritRow: roster.observations.inheritRow,
    projectRows: roster.observations.projectRows,
    reconcileRunTerminal,
    refresh: roster.refresh,
    invalidate: roster.scheduleEvent,
    refreshReplacement: roster.refreshReplacement,
    reconcileMutation: roster.reconcileMutation,
    capturePermissionObservation: permissions.capture,
    createResult: mutations.createResult,
    create: mutations.create,
    ...operations,
    patch: mutations.patch,
    patchMany: mutations.patchMany,
    archiveVisibility: mutations.archiveVisibility,
    beginArchive: mutations.beginArchive,
    assignOwner: mutations.assignOwner,
    retireModelOverride: mutations.retireModelOverride,
    think: thinkingClaims.get,
    settingsPreview: mutations.settingsPreview,
    patchRowLocal: mutations.patchRowLocal,
    isPreparedWorkSession: mutations.isPreparedWorkSession,
    pullRequestSummary,
    capturePullRequestEpoch,
    setPullRequestSummary,
    delete: deletions.delete,
    deleteMany: deletions.deleteMany,
    deletionState: deletions.deletionState,
    reset: mutations.reset,
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
      retirePresentation();
      cacheLifecycle.dispose();
      githubPublication.clear();
      roster.dispose();
      disposeOperations();
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
