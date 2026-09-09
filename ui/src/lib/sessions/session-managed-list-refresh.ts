import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { isAwaitingGatewayFailure } from "../gateway-availability.ts";
import { appendSessionResults, reconcileRosterPresentationMetadata } from "./reconcile.ts";
import type {
  SessionConnectionOwner,
  SessionGateway,
  SessionListScope,
  SessionListSnapshot,
  SessionState,
} from "./session-capability.ts";
import {
  sessionListQueryAgentId,
  type ManagedSessionList,
  type ManagedSessionListRefresh,
  type ObservedSessionList,
} from "./session-list-query.ts";
import { requestSessionListParams } from "./session-requests.ts";
import type { createSessionRosterObservations } from "./session-roster-observations.ts";

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
  }: {
    managedLists: ReadonlyMap<string, ManagedSessionList>;
    observations: Pick<
      ReturnType<typeof createSessionRosterObservations>,
      "inherit" | "accept" | "stageObservedRows"
    >;
    nextRevision: () => number;
    isPageActive: () => boolean;
  },
) {
  return (entry: ManagedSessionList, refresh: ManagedSessionListRefresh): Promise<void> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    if (entry.pending) {
      if (refresh.invalidated) {
        entry.queued = refresh;
      }
      return entry.pending;
    }
    if (refresh.append && !entry.snapshot.result) {
      return Promise.resolve();
    }
    if (!refresh.append) {
      entry.coordinator.absorb();
    }
    const isCurrent = () =>
      managedLists.get(entry.key) === entry && host.connection.isCurrent(scope);
    const drain = async () => {
      let next: ManagedSessionListRefresh | null = refresh;
      while (next && isCurrent()) {
        const requestParams = {
          ...entry.query,
          limit: next.append ? entry.query.limit : entry.retainedLimit,
          ...(next.append && next.offset !== undefined ? { offset: next.offset } : {}),
        };
        publishManagedList(entry, { ...entry.snapshot, loading: true, error: null }, isCurrent);
        try {
          const issuedRevision = nextRevision();
          const response = await requestSessionListParams(scope.client, requestParams);
          if (!isCurrent()) {
            return;
          }
          if (!response) {
            throw new Error("The session query did not return a result. Try again.");
          }
          const result = host.reconcileList(
            response,
            issuedRevision,
            sessionListQueryAgentId(entry.query),
          );
          const previous = entry.snapshot.result;
          // Only this response's rows were observed now; pagination retains older
          // members and discards duplicate page rows without refreshing their facts.
          const presented = reconcileRosterPresentationMetadata(result, previous);
          const agentId = sessionListQueryAgentId(entry.query);
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
            result?.sessions ?? [],
            scope,
            agentId,
            issuedRevision,
            false,
          );
          entry.connectionEpoch = scope.epoch;
          publishManagedList(
            entry,
            {
              result: decorated,
              agentId: sessionListQueryAgentId(entry.query) ?? null,
              loading: false,
              error: null,
            },
            isCurrent,
          );
          notifyObserved();
        } catch (error) {
          if (!isCurrent()) {
            return;
          }
          const awaitingGateway = isAwaitingGatewayFailure(error, host.snapshot());
          publishManagedList(
            entry,
            {
              ...entry.snapshot,
              loading: false,
              error: awaitingGateway ? null : formatUiError(error),
            },
            isCurrent,
          );
        }
        if (!isCurrent()) {
          return;
        }
        const queued = entry.queued;
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
      }
    });
    entry.pending = pending;
    completion.resolve(drain());
    return pending;
  };
}
