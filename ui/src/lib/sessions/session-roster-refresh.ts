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
  SessionConnectionScope,
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
  SessionState,
} from "./session-capability.ts";
import { normalizeAgentId } from "./session-key.ts";
import {
  completeSessionRefreshWaiters,
  coalesceSessionRefresh,
  isForegroundReplacement,
  isPrimarySessionListQuery,
  isSameSessionListQuery,
  prepareSessionRefreshOptions,
  retainSessionPaginationWindow,
  sessionListAgentMatcher,
  sessionListEventMatcher,
  type ManagedSessionList,
  type QueuedSessionRefresh,
  type SessionRefreshAttempt,
  type SessionRefreshOutcome,
} from "./session-list-query.ts";
import {
  createSessionManagedListRefresh,
  publishManagedList,
  type SessionListRefreshHost,
} from "./session-managed-list-refresh.ts";
import { normalizeManagedSessionListQuery, requestSessionList } from "./session-requests.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";

type SessionRosterRefreshHost = SessionListRefreshHost & {
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
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
  const eventRevisions = new WeakMap<
    object,
    {
      revision: number;
      scope: SessionConnectionScope | null;
      lists: ReadonlySet<ManagedSessionList>;
    }
  >();
  const captureEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return { revision: requestRevision, scope: host.connection.capture() };
    }
    const previous = eventRevisions.get(payload);
    if (previous !== undefined) {
      return previous;
    }
    const observation = {
      revision: ++requestRevision,
      scope: host.connection.capture(),
      lists: new Set([...managedLists.values()].filter(sessionListEventMatcher(payload))),
    };
    eventRevisions.set(payload, observation);
    return observation;
  };
  // A queued foreground replacement owns publication; older loads may only finish for callers.
  let foregroundPublicationGeneration = 0;
  let inFlight: Promise<SessionRefreshAttempt | null> | null = null;
  let queuedRefresh: QueuedSessionRefresh | null = null;
  let eventRefreshQueued = false;
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
        refresh: () =>
          refreshManagedList(entry, { append: false, invalidated: true, background: true }),
      }),
      pending: null,
      queued: null,
    };
    managedLists.set(key, entry);
    return entry;
  };

  const subscribeManagedList = (
    entry: ManagedSessionList,
    listener: (snapshot: SessionListSnapshot) => void,
  ) => {
    const subscribed = (snapshot: SessionListSnapshot) => listener(snapshot);
    entry.listeners.add(subscribed);
    entry.coordinator.setActive(pageActive);
    return () => {
      entry.listeners.delete(subscribed);
      if (entry.listeners.size > 0 || managedLists.get(entry.key) !== entry) {
        return;
      }
      // Keep invalidation dormant until observed again, without runnable queued work.
      entry.coordinator.setActive(false, entry.queued !== null);
      entry.queued = null;
      const release = () => {
        if (entry.listeners.size === 0 && managedLists.get(entry.key) === entry) {
          entry.coordinator.dispose();
          managedLists.delete(entry.key);
        }
      };
      // Route replacement may briefly remove every subscriber while this query still owns a request.
      if (entry.pending) {
        void entry.pending.finally(release);
      } else {
        release();
      }
    };
  };

  const scheduleManagedLists = (
    matches: (entry: ManagedSessionList) => boolean,
    excludedKey?: string,
  ) => {
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
    scheduleManagedLists(matches, sourceKey);
  };

  const refreshManagedList = createSessionManagedListRefresh(host, {
    managedLists,
    observations,
    nextRevision: () => ++requestRevision,
    isPageActive: () => pageActive,
  });

  const list = async (options: SessionListOptions = {}): Promise<SessionsListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const issuedRevision = ++requestRevision;
      const result = await requestSessionList(scope.client, options);
      return host.connection.isCurrent(scope)
        ? host.decorate(host.reconcileList(result ?? null, issuedRevision, options.agentId), {
            scope: options,
          })
        : null;
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      throw error;
    }
  };

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
                    currentState.result?.sessions.filter((row) =>
                      observations.hasLiveObservation(row),
                    ) ?? [],
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
      return { result, outcome: { status: "refreshed" } };
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
        ? { result: null, outcome: { status: "failed", error: message } }
        : null;
    }
  };

  const absorbPendingEventRefresh = () => {
    eventRefreshCoordinator.absorb();
    eventRefreshQueued = false;
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
    // Claim inFlight before load publishes; each caller awaits its own load, never later events.
    const completion = createDeferredCore<SessionRefreshAttempt | null>();
    const request = completion.promise.finally(() => {
      if (inFlight !== request) {
        return;
      }
      inFlight = null;
      const successor = queuedRefresh;
      if (successor) {
        if (successor.intent !== "explicit") {
          void host.background(successor, drainQueuedRefresh);
        } else {
          void drainQueuedRefresh();
        }
      } else if (eventRefreshQueued && pageActive && host.connection.isCurrent(scope)) {
        void host.background(request, refreshFromEvent);
      }
    });
    inFlight = request;
    completion.resolve(load(prepared, bootstrap, isErrorCurrent));
    if (queued) {
      completeSessionRefreshWaiters(queued, prepared, request, snapshot);
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
      absorbPendingEventRefresh();
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
          bootstrap,
          completions: [{ options, complete: completion.resolve }],
        },
        host.snapshot(),
      );
      // A rejected replacement cannot retire the writer that still owns loading completion.
      if (foregroundReplacement && isForegroundReplacement(queuedRefresh.options)) {
        foregroundPublicationGeneration += 1;
      }
      if (!inFlight) {
        void host.background(queuedRefresh, drainQueuedRefresh);
      }
      return completion.promise;
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (host.readState().result && !options.force && !hasListOverrides) {
      return Promise.resolve({ result: host.readState().result, outcome: { status: "refreshed" } });
    }
    if (foregroundReplacement) {
      foregroundPublicationGeneration += 1;
    }
    if (options.append !== true) {
      absorbPendingEventRefresh();
    }
    return startRefresh(options, bootstrap, isErrorCurrent);
  };

  const refresh = async (options: SessionRefreshOptions = {}): Promise<void> => {
    await refreshInternal(options, false);
  };

  const refreshFromEvent = async (): Promise<void> => {
    if (!eventRefreshQueued || queuedRefresh || !host.connection.capture()) {
      return;
    }
    if (inFlight) {
      await inFlight;
      return;
    }
    eventRefreshQueued = false;
    await startRefresh({ ...lastListOptions, force: true });
  };

  const eventRefreshCoordinator = createSessionEventRefreshCoordinator({
    active: pageActive,
    refresh: () => {
      eventRefreshQueued = true;
      return inFlight
        ? refreshFromEvent()
        : host.background(eventRefreshCoordinator, refreshFromEvent);
    },
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

  const replacementOptions = (agentId?: string | null): SessionRefreshOptions => {
    const options = { ...lastListOptions };
    if (agentId?.trim()) {
      options.agentId = agentId.trim();
    }
    return { ...options, force: true };
  };
  return {
    observeGateway(snapshot: SessionGateway["snapshot"], connectionChanged: boolean) {
      const available = isGatewayAvailable(snapshot);
      if (available && !gatewayAvailable && !connectionChanged) {
        invalidateManagedLists();
      }
      gatewayAvailable = available;
    },
    captureReconciliation: () => observations.captureReconciliation(++requestRevision),
    copyRow: observations.copyRow,
    inheritRow: observations.inheritRow,
    mergeRow: observations.mergeRow,
    registerRow: observations.registerRow,
    currentRow: observations.currentRow,
    mergeRows: observations.mergeRows,
    rowRevision: observations.rowRevision,
    hasLiveObservation: observations.hasLiveObservation,
    isCurrentRow: observations.isCurrentRow,
    inherit: observations.inherit,
    observeReadRow: observations.observeReadRow,
    observeReadRows: observations.observeReadRows,
    bindOwner: observations.bindOwner,
    observeFields: observations.observeFields,
    fieldObservation: observations.fieldObservation,
    stageObservedRows: observations.stageObservedRows,
    stageManagedResults: observations.stageManagedResults,
    stageRunTerminal: observations.stageRunTerminal,
    projectFields: observations.projectFields,
    projectRows: observations.projectRows,
    captureEvent,
    primaryList: () => primaryList,
    get requestRevision() {
      return requestRevision;
    },
    list,
    listSnapshot(scope: SessionListScope): SessionListSnapshot {
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
      return subscribeManagedList(managedList(scope), listener);
    },
    observeList: (scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) => {
      const entry = managedList(scope);
      const unsubscribe = subscribeManagedList(entry, listener);
      let disposed = false;
      const check = () => {
        if (disposed || managedLists.get(entry.key) !== entry) {
          throw new Error("This session query has been disposed.");
        }
      };
      try {
        listener(entry.snapshot);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return {
        async refresh() {
          check();
          const connection = host.connection.capture();
          if (!connection) {
            throw new Error("The session query is unavailable while disconnected. Try again.");
          }
          await refreshManagedList(entry, { append: false, invalidated: true });
          check();
          if (!host.connection.isCurrent(connection)) {
            throw new Error("The session query connection changed. Try again.");
          }
          if (entry.snapshot.error) {
            throw new Error(entry.snapshot.error);
          }
        },
        dispose() {
          if (!disposed) {
            disposed = true;
            unsubscribe();
          }
        },
      };
    },
    refreshList(options: SessionRefreshOptions = {}): Promise<void> {
      if (isPrimarySessionListQuery(options)) {
        return refresh(options);
      }
      const entry = managedList(options);
      return refreshManagedList(entry, {
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
    refreshReplacement: (agentId?: string | null) =>
      refreshInternal(
        replacementOptions(agentId),
        false,
        undefined,
        agentId?.trim() ? "explicit" : "automatic",
      ).then((attempt) => attempt?.result ?? null),
    refreshSelection: (selectedAgent: () => string | null) =>
      refreshInternal(replacementOptions(selectedAgent()), false, undefined, selectedAgent),
    refreshReplacementResult: (
      agentId?: string | null,
      isErrorCurrent?: () => boolean,
    ): Promise<SessionRefreshOutcome> =>
      refreshInternal(
        replacementOptions(agentId),
        false,
        isErrorCurrent,
        agentId?.trim() ? "explicit" : "reconcile",
      ).then((attempt) => attempt?.outcome ?? { status: "stale" }),
    publishedRow: observations.publishedRow,
    /** Republishes every held list through `decorate` so a UI-owned overlay
     * reaches the archived/all snapshots too, not just the primary state. */
    redecorateLists() {
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
    // Gateway-owned membership filters require an authoritative list refresh.
    canApplyPrimarySnapshot: () => isPrimarySessionListQuery(lastListOptions),
    invalidateManagedLists,
    scheduleEvent(
      this: void,
      options: { agentId?: string | null; primarySnapshotApplied?: boolean; event?: unknown } = {},
    ) {
      const matchesAgent = sessionListAgentMatcher(options.agentId);
      if (!options.primarySnapshotApplied && matchesAgent(lastListOptions.agentId)) {
        eventRefreshCoordinator.schedule();
      }
      const event = options.event;
      const affected =
        event && typeof event === "object" ? eventRevisions.get(event)?.lists : undefined;
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
      eventRefreshQueued = false;
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
