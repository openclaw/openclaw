import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  isAgentDatabaseInspectionPendingError,
  isAwaitingGatewayFailure,
  isGatewayAvailable,
} from "../gateway-availability.ts";
import { listen } from "../reactive/listener.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { appendSessionResults, preserveCurrentSessionRow } from "./reconcile.ts";
import { normalizeAgentId } from "./session-key.ts";
import {
  canApplySessionListSnapshot,
  isPrimarySessionListQuery,
  isSameSessionListQuery,
  prepareSessionRefreshOptions,
  retainSessionPaginationWindow,
  sessionListAgentMatcher,
  sessionListEventMatcher,
  sessionListsNeedingEventRefresh,
  sessionListReadNeedsEventRefresh,
  type ManagedSessionList,
  type SessionRefreshAttempt,
  type SessionListRead,
} from "./session-list-query.ts";
import {
  createSessionManagedListRefresh,
  getManagedSessionList,
  publishManagedList,
} from "./session-managed-list-refresh.ts";
import { createSessionPrimaryWindows } from "./session-primary-windows.ts";
import type { SessionRosterRefreshHost } from "./session-refresh-types.ts";
import { sessionListQueryKey } from "./session-requests.ts";
import { createSessionRosterListReader } from "./session-roster-list-reader.ts";
import { createSessionMutationRefresh } from "./session-roster-mutation-refresh.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
} from "./session-types.ts";

export function createSessionRosterRefresh(host: SessionRosterRefreshHost) {
  let gatewayAvailable = isGatewayAvailable(host.snapshot());
  let requestRevision = 0;
  // A queued foreground replacement owns publication; older loads may only finish for callers.
  let foregroundPublicationGeneration = 0;
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
    requests.resetPrimary();
  };

  const managedList = (scope: SessionListScope) =>
    getManagedSessionList(managedLists, scope, (entry, isCurrent) =>
      refreshManagedList(entry, { append: false, invalidated: true, background: true }, isCurrent),
    );

  const primaryWindows = createSessionPrimaryWindows(
    managedLists,
    managedList,
    host.onWarmListsRetired,
    host.readState,
  );
  const retireWarmLists = (matches: (entry: ManagedSessionList) => boolean = () => true) =>
    primaryWindows.invalidate(matches, lastListOptions);

  const scheduleManagedLists = (
    matches: (entry: ManagedSessionList) => boolean,
    excludedKey?: string,
    options: { foreground?: boolean } = {},
  ) => {
    // Dormant primary windows cannot close event gaps until selection revalidates them.
    primaryWindows.retire((entry) => entry.key !== excludedKey && matches(entry));
    for (const entry of managedLists.values()) {
      if (entry.key !== excludedKey && matches(entry)) {
        entry.readGeneration += 1;
        if (options.foreground && pageActive && entry.listeners.size > 0) {
          // Accepted user actions need authoritative membership now,
          // independently of a slow primary read or background bootstrap.
          void refreshManagedList(entry, { append: false, invalidated: true });
        } else {
          entry.coordinator.schedule();
        }
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
    observedReadRevision?: number,
    immediate = false,
  ) => {
    const matches = sessionListEventMatcher({ agentId, session: row });
    // Adopting a query's accepted row into the primary roster cannot make
    // that supplying query stale. Other membership projections still refresh.
    scheduleManagedLists(
      (entry) =>
        // A list already covers metadata requested before it; real events
        // and later observations still retire its pages and schedule a fresh read.
        !(
          (entry.pending || entry.snapshot.readSucceeded === true) &&
          observedReadRevision !== undefined &&
          entry.readRevision >= observedReadRevision
        ) && matches(entry.query, entry.snapshot.result),
      sourceListScope && sessionListQueryKey(sourceListScope),
      { foreground: immediate },
    );
  };

  const requests = createSessionManagedListRefresh(host, {
    managedLists,
    open: managedList,
    release: primaryWindows.release,
    observations,
    nextRevision: () => ++requestRevision,
    isPageActive: () => pageActive,
    publishPrimary: (result) =>
      host.publish({ ...host.readState(), result: host.decorate(result, primaryList) }),
    primary: {
      prepare: (read, options, bootstrap, isErrorCurrent) =>
        preparePrimary(read, options, bootstrap, isErrorCurrent),
      retirePublication: () => {
        foregroundPublicationGeneration += 1;
      },
      absorb: () => eventRefreshCoordinator.absorb(),
      retry: (delayMs) => eventRefreshCoordinator.scheduleRetry(delayMs),
      options: (agentId) => replacementOptions(agentId),
    },
  });
  const refreshManagedList = requests.refresh;

  const listReader = createSessionRosterListReader(
    host,
    () => ++requestRevision,
    observations,
    () => primaryList,
  );

  const preparePrimary = (
    read: SessionListRead,
    options: SessionRefreshOptions,
    bootstrap: boolean,
    isErrorCurrent?: () => boolean,
  ) => {
    const scope = read.scope;
    const publicationGeneration = foregroundPublicationGeneration;
    const warmRevision = primaryWindows.revision;
    const isCurrent = () =>
      host.connection.isCurrent(scope) && publicationGeneration === foregroundPublicationGeneration;
    const { append = false, force: _force, backgroundHydrate = false, ...requestOptions } = options;
    // Pagination is request-local; replacements retain filters but restart at page one.
    const { offset: _offset, ...pageOptions } = requestOptions;
    // Load More omits ownerFirst on the wire; the signed-in prefix still owns its wake and retry.
    const durableListOptions = append
      ? prepareSessionRefreshOptions(pageOptions, host.snapshot())
      : pageOptions;
    if (!backgroundHydrate || bootstrap || listOptionsSource === "none") {
      if (!isSameSessionListQuery(lastListOptions, durableListOptions, append)) {
        eventRefreshCoordinator.acceptWindowExpiry(null);
      }
      lastListOptions = durableListOptions;
      listOptionsSource = backgroundHydrate ? "seeded" : "foreground";
    }
    const finishWindowRead = eventRefreshCoordinator.beginWindowRead(
      read.issuedAt,
      isCurrent,
      append,
    );
    if (!backgroundHydrate) {
      const error = host.observerError();
      host.publish(
        { ...host.readState(), loading: true, error, deletedSessions: [] },
        error ? "session-observer" : undefined,
      );
    }
    return {
      isCurrent,
      finishWindowRead,
      accept(
        result: SessionsListResult | null,
        failure?: { error: unknown },
      ): SessionRefreshAttempt | null {
        if (!isCurrent()) {
          return null;
        }
        try {
          if (failure) {
            throw failure.error;
          }
          eventRefreshCoordinator.acceptWindowExpiry(read.expiry, append);
          const issuedRevision = read.revision;
          const currentState = host.readState();
          const mergeWithCurrent =
            !currentState.resultCached && append && requestOptions.offset !== undefined;
          const currentResult = currentState.resultCached ? null : currentState.result;
          const observed = observations.accept(result, currentState, null, requestOptions.agentId);
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
          if (!isSameSessionListQuery(primaryList.scope, durableListOptions, mergeWithCurrent)) {
            primaryList = { scope: durableListOptions };
          }
          primaryList.scope = append ? lastListOptions : durableListOptions;
          nextResult = host.decorate(nextResult, primaryList);
          if (
            sessionListReadNeedsEventRefresh(
              currentResult,
              result,
              nextResult,
              issuedRevision,
              durableListOptions,
              observations.rowRevision,
            )
          ) {
            eventRefreshCoordinator.schedule();
          }
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
            primaryWindows.capture(primaryList.scope, nextResult, read.scope.epoch);
          }
          const state = host.readState();
          const error = host.observerError();
          host.publish(
            {
              ...state,
              result: nextResult,
              resultCached: false,
              agentId: requestOptions.agentId?.trim()
                ? normalizeAgentId(requestOptions.agentId)
                : null,
              loading: backgroundHydrate ? state.loading : false,
              startupPending: false,
              error,
              deletedSessions: [],
            },
            error ? "session-observer" : undefined,
          );
          notifyObserved();
          return { options, matchesRequestedQuery: true, result, outcome: { status: "refreshed" } };
        } catch (error) {
          if (!isCurrent()) {
            return null;
          }
          const message = formatUiError(error);
          const ownsError = isErrorCurrent?.() !== false;
          const state = host.readState();
          host.publish(
            {
              ...state,
              loading: backgroundHydrate ? state.loading : false,
              error: ownsError
                ? isAwaitingGatewayFailure(error, host.snapshot())
                  ? null
                  : message
                : state.error,
              startupPending: isAgentDatabaseInspectionPendingError(error),
              deletedSessions: [],
            },
            ownsError ? (isPrimarySessionListQuery(options) ? "list" : "operation") : undefined,
          );
          return ownsError
            ? {
                options,
                matchesRequestedQuery: true,
                result: null,
                outcome: { status: "failed", error: message },
              }
            : null;
        }
      },
    };
  };

  const refresh = (options: SessionRefreshOptions = {}): Promise<void> =>
    requests.refreshPrimary(options).then(() => undefined);

  const eventRefreshCoordinator = createSessionEventRefreshCoordinator({
    active: pageActive,
    refresh: (isCurrent) =>
      host.background(eventRefreshCoordinator, () => {
        if (!pageActive) {
          eventRefreshCoordinator.setActive(false, true);
          return Promise.resolve();
        }
        return requests.refreshEvent(isCurrent);
      }),
  });

  const handlePageLifecycle = (event: Event) => {
    const markDirty = event.type === "pagehide";
    pageActive = !markDirty && document.visibilityState !== "hidden";
    eventRefreshCoordinator.setActive(pageActive, markDirty || requests.primaryPending !== null);
    for (const entry of managedLists.values()) {
      if (entry.listeners.size > 0) {
        entry.coordinator.setActive(pageActive, markDirty || entry.pending !== null);
      }
    }
  };

  const lifecycleListeners = observesPageLifecycle
    ? [
        listen(document, "visibilitychange", handlePageLifecycle),
        listen(globalThis, "pagehide", handlePageLifecycle),
        listen(globalThis, "pageshow", handlePageLifecycle),
      ]
    : [];

  const replacementOptions = (agentId?: string | null): SessionRefreshOptions => ({
    ...lastListOptions,
    ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
    force: true,
  });
  const reconcileMutation = createSessionMutationRefresh(host, {
    foreground: () => ({ agentId: lastListOptions.agentId, initial: listOptionsSource === "none" }),
    replacementOptions,
    invalidate: (agentId, immediate) =>
      invalidateManagedLists(agentId, undefined, undefined, undefined, immediate),
    refresh: (options, isErrorCurrent) =>
      requests.refreshPrimary(options, false, isErrorCurrent, "reconcile"),
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
      const lists = sessionListsNeedingEventRefresh(
        managedLists.values(),
        payload,
        matches,
        observations.observedRow,
        scope?.epoch ?? null,
        host.snapshot().selfUser?.id,
      );
      return {
        revision,
        scope,
        lists,
        affectsPrimary: matches({ agentId: lastListOptions.agentId }),
        ...observations.captureEventDelivery(scope),
      };
    },
    primaryList: () => primaryList,
    get requestRevision() {
      return requestRevision;
    },
    list: listReader.list,
    listSnapshot: primaryWindows.snapshot,
    subscribeList(scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) {
      // Subscribers share the capability-owned membership window and its refresh lifecycle.
      return primaryWindows.subscribe(managedList(scope), listener, pageActive);
    },
    observeList: (scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) => {
      const entry = managedList(scope);
      return primaryWindows.observe(entry, listener, pageActive, host.connection, () =>
        refreshManagedList(
          entry,
          entry.snapshot.result ? { append: false, invalidated: true } : { append: false },
        ),
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
    wakeList(this: void, scope: SessionListScope) {
      const agentId = (options: SessionListScope) =>
        options.agentId ? normalizeAgentId(options.agentId) : null;
      if (!isPrimarySessionListQuery(scope)) {
        managedList(scope).coordinator.wake();
      } else if (agentId(scope) === agentId(lastListOptions)) {
        eventRefreshCoordinator.wake();
      } else {
        // Another agent's read owns the primary window; read the requested agent instead.
        void refresh({ ...scope, force: true });
      }
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
    bootstrap: (options: SessionRefreshOptions, foreground = false) =>
      requests.refreshPrimary(
        {
          ...options,
          includeDerivedTitles: true,
          includeLastMessage: true,
          backgroundHydrate: true,
          force: true,
        },
        true,
        undefined,
        "automatic",
        foreground,
      ),
    refreshAutomatic: (options: SessionRefreshOptions) =>
      requests.refreshPrimary(options, false, undefined, "automatic"),
    refreshReplacement: () =>
      requests
        .refreshPrimary(replacementOptions(), false, undefined, "automatic")
        .then((attempt) => (attempt?.matchesRequestedQuery ? attempt.result : null)),
    refreshSelection: (selectedAgent: () => string | null, foreground = false) => {
      if (foreground) {
        // Only primary publication retires; a shared observed read still owns its caller.
        requests.replacePrimary();
      }
      return requests.refreshPrimary(
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
      staged.notify();
      // Local overlays must settle even if a retained list has not revalidated this connection.
      for (const entry of managedLists.values()) {
        const decorated = host.decorate(entry.snapshot.result, entry);
        if (decorated !== entry.snapshot.result) {
          publishManagedList(entry, { ...entry.snapshot, result: decorated });
        }
      }
    },
    lastOptions: () => lastListOptions,
    retireWarmLists,
    selectionPresentation(agentId: string | null) {
      const connection = host.connection.capture();
      return connection && !host.observerError() && agentId
        ? primaryWindows.presentation(replacementOptions(agentId), connection.epoch)
        : null;
    },
    canApplyPrimarySnapshot(payload: unknown) {
      const state = host.readState();
      return (
        state &&
        state.error === null &&
        !state.resultCached &&
        canApplySessionListSnapshot(
          state.result,
          payload,
          lastListOptions,
          "updatedAt",
          observations.observedRow,
          host.snapshot().selfUser?.id,
        )
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
    reset(retireData = false) {
      retireForegroundRefresh();
      primaryList = { scope: primaryList.scope };
      eventRefreshCoordinator.reset();
      for (const entry of managedLists.values()) {
        entry.coordinator.reset();
        entry.startupRetryAttempt = 0;
        entry.pending = entry.queued = null;
        entry.reads.clear();
        if (entry.listeners.size === 0) {
          managedLists.delete(entry.key);
          continue;
        }
        if (retireData) {
          entry.receivedKeys.clear();
          entry.retainedLimit = entry.query.limit;
          entry.connectionEpoch = null;
          publishManagedList(entry, { result: null, agentId: null, loading: false, error: null });
        } else if (
          entry.snapshot.loading ||
          entry.snapshot.error ||
          entry.snapshot.startupPending
        ) {
          publishManagedList(entry, {
            ...entry.snapshot,
            loading: false,
            error: null,
            startupPending: false,
          });
        }
      }
    },
    dispose() {
      retireForegroundRefresh();
      eventRefreshCoordinator.dispose();
      lifecycleListeners.forEach((release) => release());
      for (const entry of managedLists.values()) {
        entry.coordinator.dispose();
        entry.listeners.clear();
      }
      managedLists.clear();
    },
  };
}
