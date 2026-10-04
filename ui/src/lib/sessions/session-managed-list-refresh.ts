import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  isAgentDatabaseInspectionPendingError,
  isAwaitingGatewayFailure,
  resolveGatewayReadRetryDelayMs,
} from "../gateway-availability.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { appendSessionResults, reconcileRosterPresentationMetadata } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionGateway,
  SessionListScope,
  SessionListSnapshot,
  SessionState,
} from "./session-capability.ts";
import type {
  ManagedSessionList,
  ManagedSessionListRefresh,
  ObservedSessionList,
} from "./session-list-query.ts";
import {
  normalizeManagedSessionListQuery,
  requestSessionListParams,
  sessionListQueryKey,
} from "./session-requests.ts";
import type { createSessionRosterObservations } from "./session-roster-observations.ts";

export function getManagedSessionList(
  lists: Map<string, ManagedSessionList>,
  scope: SessionListScope,
  refresh: (entry: ManagedSessionList, isCurrent: () => boolean) => Promise<void>,
): ManagedSessionList {
  const key = sessionListQueryKey(scope);
  const current = lists.get(key);
  if (current) {
    return current;
  }
  const query = normalizeManagedSessionListQuery(scope);
  const entry: ManagedSessionList = {
    key,
    query,
    scope: Object.freeze({ ...scope }),
    retainedLimit: query.limit,
    startupRetryAttempt: 0,
    readGeneration: 0,
    connectionEpoch: null,
    snapshot: { result: null, agentId: null, loading: false, error: null },
    listeners: new Set(),
    coordinator: createSessionEventRefreshCoordinator({
      active: false,
      refresh: (isCurrent) => refresh(entry, isCurrent),
    }),
    pending: null,
    queued: null,
  };
  lists.set(key, entry);
  return entry;
}

export function publishManagedList(
  entry: ObservedSessionList,
  snapshot: SessionListSnapshot,
  isCurrent: () => boolean = () => true,
): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    if (!isCurrent() || entry.snapshot !== snapshot) {
      return;
    }
    listener(snapshot);
  }
}

export type SessionListRefreshHost = {
  background: (key: string | object, task: () => Promise<unknown>) => Promise<void>;
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  decorate: (
    result: SessionsListResult | null,
    owner: { scope: SessionListScope },
  ) => SessionsListResult | null;
  reconcileList: (
    result: SessionsListResult | null,
    issuedRevision: number,
    agentId?: string,
  ) => SessionsListResult | null;
};

/** Owns each managed window's pending request and queued replacement drain. */
export function createSessionManagedListRefresh(
  host: SessionListRefreshHost,
  {
    managedLists,
    observations,
    nextRevision,
    isPageActive,
    publishPrimary,
  }: {
    managedLists: ReadonlyMap<string, ManagedSessionList>;
    observations: Pick<
      ReturnType<typeof createSessionRosterObservations>,
      "inherit" | "accept" | "stageObservedRows" | "mergeRows"
    >;
    nextRevision: () => number;
    isPageActive: () => boolean;
    publishPrimary: (result: SessionsListResult | null) => void;
  },
) {
  const refreshManagedList = (
    entry: ManagedSessionList,
    refresh: ManagedSessionListRefresh,
  ): Promise<void> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    if (entry.pending) {
      // A subscriber may extend the accepted window before this drain settles.
      if (refresh.append && !entry.snapshot.loading && !entry.queued) {
        entry.queued = refresh;
      }
      if (
        refresh.invalidated &&
        (!refresh.background || !entry.queued || entry.queued.background)
      ) {
        entry.readGeneration += 1;
        entry.queued = refresh;
      }
      return entry.pending;
    }
    // Another bootstrap path can hydrate this query while its initial fill waits for admission.
    if (
      refresh.background &&
      !refresh.invalidated &&
      !refresh.append &&
      entry.connectionEpoch === scope.epoch
    ) {
      return Promise.resolve();
    }
    if (refresh.append && !entry.snapshot.result) {
      return Promise.resolve();
    }
    if (!refresh.append) {
      entry.queued = null;
    }
    const isCurrent = () =>
      managedLists.get(entry.key) === entry && host.connection.isCurrent(scope);
    const drain = async () => {
      let next: ManagedSessionListRefresh | null = refresh;
      while (next && isCurrent()) {
        if (!next.append) {
          entry.coordinator.absorb();
        }
        const requestParams = {
          ...entry.query,
          limit: next.append ? entry.query.limit : entry.retainedLimit,
          ...(next.append && next.offset !== undefined ? { offset: next.offset } : {}),
        };
        publishManagedList(entry, { ...entry.snapshot, loading: true, error: null }, isCurrent);
        try {
          const issuedRevision = nextRevision();
          const generation = entry.readGeneration;
          const readIsCurrent = () =>
            isCurrent() &&
            (!requestParams.pageSize ||
              (generation === entry.readGeneration && isPageActive() && entry.listeners.size > 0));
          const response = await requestSessionListParams(
            scope.client,
            requestParams,
            readIsCurrent,
          );
          if (!isCurrent()) {
            return;
          }
          if (!readIsCurrent()) {
            // Retired pages cannot start another RPC or publish a partial window.
            // Automatic invalidation stays paced by the existing coordinator.
            publishManagedList(entry, { ...entry.snapshot, loading: false }, isCurrent);
            if (!entry.queued || entry.queued.background || !isPageActive()) {
              return;
            }
            next = entry.queued;
            entry.queued = null;
            continue;
          }
          if (!response) {
            throw new Error("The session query did not return a result. Try again.");
          }
          if (
            next.append &&
            response.hasMore &&
            (response.nextOffset ?? (requestParams.offset ?? 0) + response.sessions.length) <=
              (requestParams.offset ?? 0)
          ) {
            throw new Error("Session list pagination did not advance.");
          }
          const result = host.reconcileList(response, issuedRevision, entry.query.agentId);
          const previous = entry.snapshot.result;
          // Only this response's rows were observed now; pagination retains older
          // members and discards duplicate page rows without refreshing their facts.
          const presented = reconcileRosterPresentationMetadata(result, previous);
          const agentId = entry.query.agentId;
          observations.inherit(presented, result, previous, agentId);
          const observed = observations.accept(
            presented,
            previous,
            host.readState().result,
            agentId,
            entry.snapshot.agentId,
          );
          const nextResult =
            observed && next.append && requestParams.offset && previous
              ? appendSessionResults(previous, observed)
              : observed;
          const decorated = host.decorate(nextResult, entry);
          if (decorated) {
            entry.retainedLimit = Math.max(entry.retainedLimit, decorated.sessions.length);
          }
          const notifyObserved = observations.stageObservedRows(
            observed?.sessions ?? [],
            scope,
            agentId,
            undefined,
            false,
          );
          entry.connectionEpoch = scope.epoch;
          entry.startupRetryAttempt = 0;
          const snapshot: SessionListSnapshot = {
            result: decorated,
            agentId: agentId ?? null,
            loading: false,
            error: null,
          };
          // Stage this window before notifying primary observers. Each query keeps
          // its membership; only overlapping, admitted row facts reach the primary.
          entry.snapshot = snapshot;
          const primary = host.readState();
          const merged = observations.mergeRows(
            primary.result,
            decorated?.sessions ?? [],
            primary.agentId,
            agentId,
          );
          if (merged !== primary.result) {
            publishPrimary(merged);
          }
          // Primary listeners can retire the connection or replace this snapshot.
          if (isCurrent() && entry.snapshot === snapshot) {
            publishManagedList(entry, snapshot, isCurrent);
          }
          notifyObserved();
        } catch (error) {
          if (!isCurrent()) {
            return;
          }
          const awaitingGateway = isAwaitingGatewayFailure(error, host.snapshot());
          const startupPending = isAgentDatabaseInspectionPendingError(error);
          if (startupPending) {
            entry.coordinator.scheduleRetry(
              resolveGatewayReadRetryDelayMs(error, entry.startupRetryAttempt++),
            );
          } else {
            entry.startupRetryAttempt = 0;
          }
          publishManagedList(
            entry,
            {
              ...entry.snapshot,
              loading: false,
              error: awaitingGateway ? null : formatUiError(error),
              startupPending,
            },
            isCurrent,
          );
        }
        if (!isCurrent()) {
          return;
        }
        const queued = entry.queued;
        if (queued?.background) {
          return;
        }
        entry.queued = null;
        next = isPageActive() ? queued : null;
      }
    };
    // Loading listeners can request a refresh before the first RPC starts.
    // Claim the pending owner first so those requests enter its trailing queue.
    const completion = createDeferredCore();
    const pending = completion.promise.finally(() => {
      if (entry.pending === pending) {
        entry.pending = null;
        if (entry.queued?.background && isCurrent() && isPageActive()) {
          // Release this request's admission before scheduling its automatic successor.
          entry.coordinator.schedule();
        }
      }
    });
    entry.pending = pending;
    completion.resolve(drain());
    return pending;
  };
  return (
    entry: ManagedSessionList,
    refresh: ManagedSessionListRefresh,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    if (!refresh.background || entry.pending) {
      return refreshManagedList(entry, refresh);
    }
    if (!entry.queued || (refresh.invalidated && entry.queued.background)) {
      entry.queued = refresh;
    }
    return host.background(entry, async () => {
      if (isCurrent() && managedLists.get(entry.key) === entry && entry.listeners.size > 0) {
        if (!isPageActive()) {
          entry.coordinator.setActive(false, true);
          return;
        }
        // Scheduler deduplication must retain invalidation that arrives after the initial fill.
        const queued = entry.queued ?? refresh;
        entry.queued = null;
        await refreshManagedList(entry, queued);
      }
    });
  };
}
