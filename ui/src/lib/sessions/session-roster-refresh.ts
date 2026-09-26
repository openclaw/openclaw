import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { isGatewayAvailable } from "../gateway-availability.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import {
  appendSessionResults,
  preserveCurrentSessionRow,
  reconcileRosterPresentationMetadata,
} from "./reconcile.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
  SessionState,
} from "./session-capability.ts";
import { normalizeAgentId } from "./session-key.ts";
import {
  canApplySessionListSnapshot,
  coalesceSessionRefresh,
  completeSessionRefreshWaiters,
  isForegroundReplacement,
  isPrimarySessionListQuery,
  isSameSessionListQuery,
  prepareSessionRefreshOptions,
  queuedSessionRefreshCompletion,
  retainSessionPaginationWindow,
  sessionListAgentMatcher,
  sessionListEventMatcher,
  type ManagedSessionList,
  type QueuedSessionRefresh,
  type SessionRefreshAttempt,
} from "./session-list-query.ts";
import {
  createSessionManagedListRefresh,
  publishManagedList,
  type SessionListRefreshHost,
} from "./session-managed-list-refresh.ts";
import { createSessionPrimaryWindows } from "./session-primary-windows.ts";
import { normalizeManagedSessionListQuery, requestSessionList } from "./session-requests.ts";
import { createSessionRosterListReader } from "./session-roster-list-reader.ts";
import { createSessionMutationRefresh } from "./session-roster-mutation-refresh.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";

type SessionRosterRefreshHost = SessionListRefreshHost & {
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  onWarmListsRetired: (agentIds: ReadonlySet<string>) => void;
  observerError: () => string | null;
  onCanonicalList: (
    result: SessionsListResult | null,
    requestRevision: number,
    agentId?: string,
    observed?: SessionsListResult | null,
  ) => void;
};

export function createSessionRosterRefresh(host: SessionRosterRefreshHost) {
  let gatewayAvailable = isGatewayAvailable(host.snapshot());
  let requestRevision = 0;
  // A queued foreground replacement owns publication; older loads may only finish for callers.
  let foregroundPublicationGeneration = 0;
  let inFlight: Promise<SessionRefreshAttempt | null> | null = null;
  let queuedRefresh: QueuedSessionRefresh | null = null;
  let lastListOptions: SessionListOptions = {};
  let primaryList: { scope: SessionListScope } = { scope: {} };
  let listOptionsSource: "none" | "seeded" | "foreground" = "none";
  const observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  let pageActive = !observesPageLifecycle || document.visibilityState !== "hidden";
  const managedLists = new Map<string, ManagedSessionList>();
  const observations = createSessionRosterObservations(host, managedLists);
  const retireForegroundRefresh = () => {
    observations.reset();
    foregroundPublicationGeneration += 1;
    inFlight = null;
    queuedRefresh?.completions.forEach(({ complete }) => complete(null));
    queuedRefresh = null;
  };

  const managedList = (scope: SessionListScope): ManagedSessionList => {
    const query = normalizeManagedSessionListQuery(scope);
    const key = JSON.stringify(query);
    const current = managedLists.get(key);
    if (current) {
      return current;
    }
    const entry: ManagedSessionList = {
      key,
      query,
      scope: Object.freeze({ ...scope }),
      retainedLimit: query.limit,
      connectionEpoch: null,
      snapshot: { result: null, agentId: null, loading: false, error: null },
      listeners: new Set(),
      coordinator: createSessionEventRefreshCoordinator({
        active: false,
        refresh: (isCurrent) =>
          refreshManagedList(
            entry,
            { append: false, invalidated: true, background: true },
            isCurrent,
          ),
      }),
      pending: null,
      queued: null,
    };
    managedLists.set(key, entry);
    return entry;
  };

  const primaryWindows = createSessionPrimaryWindows(
    managedLists,
    managedList,
    host.onWarmListsRetired,
  );
  const retireWarmLists = (matches: (entry: ManagedSessionList) => boolean = () => true) =>
    primaryWindows.invalidate(matches, lastListOptions);

  const scheduleManagedLists = (
    matches: (entry: ManagedSessionList) => boolean,
    excludedKey?: string,
  ) => {
    // Dormant primary windows cannot close event gaps until selection revalidates them.
    primaryWindows.retire((entry) => entry.key !== excludedKey && matches(entry));
    for (const entry of managedLists.values()) {
      if (entry.key !== excludedKey && matches(entry)) {
        entry.coordinator.schedule();
      }
    }
  };

  const invalidateManagedLists = (
    agentId?: string | null,
    row?: Pick<
      GatewaySessionRow,
      "key" | "agentId" | "controlOwnerSessionKey" | "parentSessionKey" | "spawnedBy"
    >,
    sourceListScope?: SessionListScope,
  ) => {
    const matches = sessionListEventMatcher({ agentId, session: row });
    const sourceKey =
      sourceListScope && JSON.stringify(normalizeManagedSessionListQuery(sourceListScope));
    // Adopting a query's accepted row into the primary roster cannot make
    // that supplying query stale. Other membership projections still refresh.
    scheduleManagedLists((entry) => matches(entry.query, entry.snapshot.result), sourceKey);
  };

  const refreshManagedList = createSessionManagedListRefresh(host, {
    managedLists,
    observations,
    nextRevision: () => ++requestRevision,
    isPageActive: () => pageActive,
    publishPrimary: (result) =>
      host.publish({ ...host.readState(), result: host.decorate(result, primaryList) }),
  });

  const listReader = createSessionRosterListReader(
    host,
    () => ++requestRevision,
    observations,
    () => primaryList,
  );

  const load = async (
    options: SessionRefreshOptions,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshAttempt | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const publicationGeneration = foregroundPublicationGeneration;
    const warmRevision = primaryWindows.revision;
    const isCurrent = () =>
      host.connection.isCurrent(scope) && publicationGeneration === foregroundPublicationGeneration;
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    const durableListOptions: SessionListOptions = { ...requestOptions };
    // Pagination is request-local; replacements retain filters but restart at page one.
    delete durableListOptions.offset;
    if (!backgroundHydrate) {
      lastListOptions = durableListOptions;
      listOptionsSource = "foreground";
    } else if (bootstrap || listOptionsSource === "none") {
      // Reconnect may select a different agent; later event refreshes must use that query.
      lastListOptions = durableListOptions;
      listOptionsSource = "seeded";
    }
    if (!backgroundHydrate) {
      const error = host.observerError();
      host.publish(
        { ...host.readState(), loading: true, error, deletedSessions: [] },
        error ? "session-observer" : undefined,
      );
    }
    try {
      const issuedRevision = ++requestRevision;
      let result = await requestSessionList(scope.client, requestOptions);
      if (!isCurrent()) {
        return null;
      }
      result = host.reconcileList(result, issuedRevision, requestOptions.agentId);
      const currentState = host.readState();
      const mergeWithCurrent =
        !currentState.resultCached && append && typeof requestOptions.offset === "number";
      const currentResult = currentState.resultCached ? null : currentState.result;
      const presented = reconcileRosterPresentationMetadata(result, currentResult);
      observations.inherit(presented, result, currentResult, requestOptions.agentId);
      const observed = observations.accept(
        presented,
        currentState.result,
        null,
        requestOptions.agentId,
        currentState.agentId,
      );
      let nextResult =
        observed && mergeWithCurrent && currentResult
          ? appendSessionResults(currentResult, observed)
          : observed;
      if (append && nextResult && !backgroundHydrate) {
        lastListOptions = retainSessionPaginationWindow(
          durableListOptions,
          requestOptions.offset,
          result,
          nextResult,
          host.snapshot(),
        );
      }
      if (nextResult) {
        nextResult = preserveCurrentSessionRow(
          nextResult,
          {
            agentId: currentState.agentId,
            result: currentState.resultCached
              ? {
                  sessions:
                    currentState.result?.sessions.filter(observations.hasLiveObservation) ?? [],
                }
              : currentState.result,
          },
          host.snapshot(),
          backgroundHydrate,
        );
      }
      // Append extends this window; a different query replaces its rollback owner.
      if (!isSameSessionListQuery(primaryList.scope, durableListOptions, mergeWithCurrent)) {
        primaryList = { scope: durableListOptions };
      }
      primaryList.scope = append ? lastListOptions : durableListOptions;
      nextResult = host.decorate(nextResult, primaryList);
      const notifyObserved = observations.stageObservedRows(
        result?.sessions ?? [],
        scope,
        requestOptions.agentId,
        issuedRevision,
        false,
      );
      host.onCanonicalList(nextResult, issuedRevision, requestOptions.agentId, result);
      if (
        nextResult &&
        requestOptions.agentId &&
        warmRevision === primaryWindows.revision &&
        isPrimarySessionListQuery(primaryList.scope)
      ) {
        primaryWindows.capture(primaryList.scope, nextResult, scope.epoch);
      }
      const state = host.readState();
      const error = host.observerError();
      host.publish(
        {
          ...state,
          result: nextResult,
          resultCached: false,
          agentId: requestOptions.agentId?.trim() ? normalizeAgentId(requestOptions.agentId) : null,
          loading: backgroundHydrate ? state.loading : false,
          error,
          deletedSessions: [],
        },
        error ? "session-observer" : undefined,
      );
      notifyObserved();
      return { options, matchesRequestedQuery: true, result, outcome: { status: "refreshed" } };
    } catch (error) {
      const message = formatUiError(error);
      const ownsError = isErrorCurrent?.() !== false;
      if (isCurrent()) {
        const state = host.readState();
        host.publish(
          {
            ...state,
            loading: backgroundHydrate ? state.loading : false,
            error: ownsError ? message : state.error,
            deletedSessions: [],
          },
          ownsError ? "operation" : undefined,
        );
      }
      return isCurrent() && ownsError
        ? {
            options,
            matchesRequestedQuery: true,
            result: null,
            outcome: { status: "failed", error: message },
          }
        : null;
    }
  };

  const startRefresh = (
    options: SessionRefreshOptions,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshAttempt | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve(null);
    }
    const queued =
      !isForegroundReplacement(options) && typeof queuedRefresh?.intent === "function"
        ? null
        : queuedRefresh;
    if (queued) {
      queuedRefresh = null;
    }
    const snapshot = host.snapshot();
    const prepared = prepareSessionRefreshOptions(options, snapshot);
    // Claim inFlight before load publishes; ordinary callers await their own load, never later events.
    const completion = createDeferredCore<SessionRefreshAttempt | null>();
    let successorCompletion: Promise<SessionRefreshAttempt | null> | null = null;
    const request = completion.promise.finally(() => {
      if (inFlight !== request) {
        return;
      }
      inFlight = null;
      const successor = queuedRefresh;
      if (successor) {
        if (queued?.completions.some(({ reconcile }) => reconcile)) {
          successorCompletion = queuedSessionRefreshCompletion(successor, prepared);
        }
        if (successor.intent !== "explicit" && !successor.foreground) {
          void host.background(successor, drainQueuedRefresh);
        } else {
          void drainQueuedRefresh();
        }
      }
    });
    inFlight = request;
    completion.resolve(load(prepared, bootstrap, isErrorCurrent));
    if (queued) {
      // Capture one successor at the drain boundary, even when it completes synchronously.
      const reconciled = request.then(
        (attempt) => attempt ?? (host.connection.isCurrent(scope) ? successorCompletion : null),
      );
      completeSessionRefreshWaiters(queued, request, reconciled, snapshot);
    }
    return request;
  };

  const drainQueuedRefresh = () => {
    const queued = queuedRefresh;
    if (inFlight || !queued) {
      return Promise.resolve(null);
    }
    const options =
      typeof queued.intent === "function" ? replacementOptions(queued.intent()) : queued.options;
    if (!options.append) {
      eventRefreshCoordinator.absorb();
    }
    const snapshot = host.snapshot();
    const sameErrorQuery = isSameSessionListQuery(
      prepareSessionRefreshOptions(queued.errorOwner.options, snapshot),
      prepareSessionRefreshOptions(options, snapshot),
      false,
    );
    return startRefresh(
      options,
      queued.bootstrap,
      sameErrorQuery ? queued.errorOwner.isCurrent : undefined,
    );
  };

  const refreshInternal = (
    options: SessionRefreshOptions,
    bootstrap: boolean,
    isErrorCurrent?: () => boolean,
    intent: QueuedSessionRefresh["intent"] = "explicit",
    foreground = false,
  ): Promise<SessionRefreshAttempt | null> => {
    if (!host.connection.capture()) {
      return Promise.resolve(null);
    }
    const foregroundReplacement = isForegroundReplacement(options);
    if (inFlight || intent !== "explicit") {
      const completion = createDeferredCore<SessionRefreshAttempt | null>();
      queuedRefresh = coalesceSessionRefresh(
        queuedRefresh,
        {
          options,
          errorOwner: { options, isCurrent: isErrorCurrent },
          intent,
          foreground,
          bootstrap,
          completions: [
            { options, reconcile: intent === "reconcile", complete: completion.resolve },
          ],
        },
        host.snapshot(),
      );
      // A rejected replacement cannot retire the writer that still owns loading completion.
      if (foregroundReplacement && isForegroundReplacement(queuedRefresh.options)) {
        foregroundPublicationGeneration += 1;
      }
      if (!inFlight) {
        if (queuedRefresh.foreground) {
          void drainQueuedRefresh();
        } else {
          void host.background(queuedRefresh, drainQueuedRefresh);
        }
      }
      return completion.promise;
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (host.readState().result && !options.force && !hasListOverrides) {
      return Promise.resolve({
        options,
        matchesRequestedQuery: true,
        result: host.readState().result,
        outcome: { status: "refreshed" },
      });
    }
    if (foregroundReplacement) {
      foregroundPublicationGeneration += 1;
    }
    if (options.append !== true) {
      eventRefreshCoordinator.absorb();
    }
    return startRefresh(options, bootstrap, isErrorCurrent);
  };

  const refresh = (options: SessionRefreshOptions = {}): Promise<void> =>
    refreshInternal(options, false).then(() => undefined);

  const refreshFromEvent = async (isCurrent: () => boolean): Promise<void> => {
    const scope = host.connection.capture();
    for (let request = inFlight; request && isCurrent(); request = inFlight) {
      await request;
    }
    if (!scope || !host.connection.isCurrent(scope) || !isCurrent()) {
      return;
    }
    if (!pageActive) {
      eventRefreshCoordinator.setActive(false, true);
      return;
    }
    if (!queuedRefresh) {
      await startRefresh({ ...lastListOptions, force: true });
    }
  };

  const eventRefreshCoordinator = createSessionEventRefreshCoordinator({
    active: pageActive,
    refresh: (isCurrent) =>
      host.background(eventRefreshCoordinator, () => refreshFromEvent(isCurrent)),
  });

  const handlePageLifecycle = (event: Event) => {
    const markDirty = event.type === "pagehide";
    pageActive = !markDirty && document.visibilityState !== "hidden";
    eventRefreshCoordinator.setActive(pageActive, markDirty || inFlight !== null);
    for (const entry of managedLists.values()) {
      if (entry.listeners.size > 0) {
        entry.coordinator.setActive(pageActive, markDirty || entry.pending !== null);
      }
    }
  };

  const updatePageLifecycleListeners = (add: boolean) => {
    const method = add ? "addEventListener" : "removeEventListener";
    document[method]("visibilitychange", handlePageLifecycle);
    globalThis[method]("pagehide", handlePageLifecycle);
    globalThis[method]("pageshow", handlePageLifecycle);
  };
  if (observesPageLifecycle) {
    updatePageLifecycleListeners(true);
  }

  const replacementOptions = (agentId?: string | null): SessionRefreshOptions => ({
    ...lastListOptions,
    ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
    force: true,
  });
  const reconcileMutation = createSessionMutationRefresh(host, {
    foreground: () => ({ agentId: lastListOptions.agentId, initial: listOptionsSource === "none" }),
    replacementOptions,
    invalidate: invalidateManagedLists,
    refresh: (options, isErrorCurrent) =>
      refreshInternal(options, false, isErrorCurrent, "reconcile"),
    read: listReader.reconcile,
  });
  return {
    observeGateway(snapshot: SessionGateway["snapshot"], connectionChanged: boolean) {
      const available = isGatewayAvailable(snapshot);
      if (available && !gatewayAvailable && !connectionChanged) {
        invalidateManagedLists();
      }
      gatewayAvailable = available;
    },
    captureReconciliation: () => observations.captureReconciliation(++requestRevision),
    observations,
    captureEvent(payload: unknown) {
      const scope = host.connection.capture();
      const revision = ++requestRevision;
      const matches = sessionListEventMatcher(payload);
      const lists = new Set<ManagedSessionList>();
      for (const entry of managedLists.values()) {
        if (
          matches(entry.query, entry.snapshot.result) &&
          (entry.pending !== null ||
            entry.snapshot.error !== null ||
            !canApplySessionListSnapshot(entry.snapshot.result, payload, entry.scope))
        ) {
          lists.add(entry);
        }
      }
      return {
        revision,
        scope,
        lists,
        affectsPrimary: matches({ agentId: lastListOptions.agentId }),
        ...observations.captureEventDelivery(scope, revision),
      };
    },
    primaryList: () => primaryList,
    get requestRevision() {
      return requestRevision;
    },
    list: listReader.list,
    listSnapshot(this: void, scope: SessionListScope): SessionListSnapshot {
      if (isPrimarySessionListQuery(scope)) {
        const { result, agentId, loading, error } = host.readState();
        return { result, agentId, loading, error };
      }
      return (
        managedLists.get(JSON.stringify(normalizeManagedSessionListQuery(scope)))?.snapshot ?? {
          result: null,
          agentId: null,
          loading: false,
          error: null,
        }
      );
    },
    subscribeList(scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) {
      return primaryWindows.subscribe(managedList(scope), listener, pageActive);
    },
    observeList: (scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) => {
      const entry = managedList(scope);
      return primaryWindows.observe(entry, listener, pageActive, host.connection, () =>
        refreshManagedList(entry, { append: false, invalidated: true }),
      );
    },
    refreshList(this: void, options: SessionRefreshOptions = {}): Promise<void> {
      if (isPrimarySessionListQuery(options)) {
        return refresh(options);
      }
      return refreshManagedList(managedList(options), {
        append: options.append === true,
        ...(options.force === true && options.append !== true ? { invalidated: true } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      });
    },
    isPrimaryList: isPrimarySessionListQuery,
    async refreshManagedLists() {
      const scope = host.connection.capture();
      if (!scope) {
        return;
      }
      await Promise.all(
        [...managedLists.values()]
          .filter((entry) => entry.listeners.size > 0 && entry.connectionEpoch !== scope.epoch)
          .map((entry) => refreshManagedList(entry, { append: false, background: true })),
      );
    },
    refresh,
    bootstrap: (options: SessionRefreshOptions) =>
      refreshInternal(options, true, undefined, "automatic"),
    refreshAutomatic: (options: SessionRefreshOptions) =>
      refreshInternal(options, false, undefined, "automatic"),
    refreshReplacement: () =>
      refreshInternal(replacementOptions(), false, undefined, "automatic").then((attempt) =>
        attempt?.matchesRequestedQuery ? attempt.result : null,
      ),
    refreshSelection: (selectedAgent: () => string | null, foreground = false) => {
      if (foreground) {
        // Navigation supersedes the previous request's publication and drain ownership.
        // Its caller still settles, but a slow old agent cannot hold the new sidebar.
        foregroundPublicationGeneration += 1;
        inFlight = null;
      }
      return refreshInternal(
        replacementOptions(selectedAgent()),
        false,
        undefined,
        selectedAgent,
        foreground,
      );
    },
    reconcileMutation,
    /** Republishes every held list through `decorate` so a UI-owned overlay
     * reaches the archived/all snapshots too, not just the primary state. */
    redecorateLists(this: void) {
      const state = host.readState();
      const result = host.decorate(state.result, primaryList);
      const staged = observations.stageManagedResults(
        host.connection.capture(),
        (entry) => entry.snapshot.result,
      );
      if (result !== state.result) {
        host.publish({ ...state, result });
      }
      for (const entry of managedLists.values()) {
        const decorated = host.decorate(entry.snapshot.result, entry);
        if (decorated !== entry.snapshot.result) {
          publishManagedList(entry, { ...entry.snapshot, result: decorated });
        }
      }
      staged.notify();
    },
    lastOptions: () => lastListOptions,
    retireWarmLists,
    selectionPresentation(
      agentId: string | null,
    ): Pick<SessionListSnapshot, "result" | "agentId"> | null {
      const connection = host.connection.capture();
      return connection && !host.observerError() && agentId
        ? primaryWindows.presentation(replacementOptions(agentId), connection.epoch)
        : null;
    },
    canApplyPrimarySnapshot(payload: unknown) {
      const state = !inFlight && host.readState();
      return (
        state &&
        state.error === null &&
        !state.resultCached &&
        canApplySessionListSnapshot(state.result, payload, lastListOptions)
      );
    },
    invalidateManagedLists,
    scheduleEvent(
      this: void,
      options: {
        agentId?: string | null;
        primarySnapshotApplied?: boolean;
        affectsPrimary?: boolean;
        affectedLists?: ReadonlySet<ManagedSessionList>;
      } = {},
    ) {
      const matchesAgent = sessionListAgentMatcher(options.agentId);
      const affected = options.affectedLists;
      // Server events can invalidate a read; accepted row observations are reconciled into it.
      primaryWindows.invalidate(
        (entry) => affected?.has(entry) ?? matchesAgent(entry.query.agentId),
        lastListOptions,
      );
      if (
        !options.primarySnapshotApplied &&
        (options.affectsPrimary ?? matchesAgent(lastListOptions.agentId))
      ) {
        eventRefreshCoordinator.schedule();
      }
      if (affected) {
        scheduleManagedLists((entry) => affected.has(entry));
      } else {
        invalidateManagedLists(options.agentId);
      }
    },
    reset() {
      retireForegroundRefresh();
      primaryList = { scope: primaryList.scope };
      eventRefreshCoordinator.reset();
      for (const entry of managedLists.values()) {
        entry.coordinator.reset();
        entry.pending = entry.queued = null;
        if (entry.listeners.size === 0) {
          entry.coordinator.dispose();
          managedLists.delete(entry.key);
          continue;
        }
        if (entry.snapshot.loading || entry.snapshot.error) {
          publishManagedList(entry, { ...entry.snapshot, loading: false, error: null });
        }
      }
    },
    dispose() {
      retireForegroundRefresh();
      eventRefreshCoordinator.dispose();
      if (observesPageLifecycle) {
        updatePageLifecycleListeners(false);
      }
      for (const entry of managedLists.values()) {
        entry.coordinator.dispose();
        entry.listeners.clear();
      }
      managedLists.clear();
    },
  };
}
