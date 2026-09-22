import type { SessionsListResult } from "../../api/types.ts";
import type {
  SessionConnectionOwner,
  SessionListScope,
  SessionListSnapshot,
} from "./session-capability.ts";
import { normalizeAgentId } from "./session-key.ts";
import {
  isPrimarySessionListQuery,
  isSameSessionListQuery,
  type ManagedSessionList,
} from "./session-list-query.ts";
import { publishManagedList } from "./session-managed-list-refresh.ts";
import { normalizeManagedSessionListQuery } from "./session-requests.ts";

/** Manage presentation leases on the roster owner's existing managed-list entries. */
export function createSessionPrimaryWindows(
  managedLists: Map<string, ManagedSessionList>,
  open: (scope: SessionListScope) => ManagedSessionList,
  onRetired: (agentIds: ReadonlySet<string>) => void,
) {
  let invalidationRevision = 0;
  const retireWarmLists = (matches: (entry: ManagedSessionList) => boolean = () => true) => {
    const retiredAgents = new Set<string>();
    for (const entry of managedLists.values()) {
      if (!entry.warmPrimary || !matches(entry)) {
        continue;
      }
      entry.warmPrimary = false;
      if (entry.scope.agentId) {
        retiredAgents.add(normalizeAgentId(entry.scope.agentId));
      }
      if (entry.listeners.size === 0 && !entry.pending) {
        entry.coordinator.dispose();
        managedLists.delete(entry.key);
      }
    }
    // Consumers must withdraw a retired window even while its replacement RPC is pending.
    if (retiredAgents.size > 0) {
      onRetired(retiredAgents);
    }
  };

  /** Subscribe through the managed owner, retiring any independent primary presentation lease. */
  const subscribe = (
    entry: ManagedSessionList,
    listener: (snapshot: SessionListSnapshot) => void,
    pageActive: boolean,
  ) => {
    const subscribed = (snapshot: SessionListSnapshot) => listener(snapshot);
    entry.listeners.add(subscribed);
    // Observed queries own independent membership rather than a primary warm lease.
    retireWarmLists((candidate) => candidate === entry);
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
        if (
          !entry.warmPrimary &&
          entry.listeners.size === 0 &&
          managedLists.get(entry.key) === entry
        ) {
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

  return {
    subscribe,
    /** Own an observed query subscription and fence explicit refresh against disposal. */
    observe(
      entry: ManagedSessionList,
      listener: (snapshot: SessionListSnapshot) => void,
      pageActive: boolean,
      connectionOwner: SessionConnectionOwner,
      refresh: () => Promise<unknown>,
    ) {
      const unsubscribe = subscribe(entry, listener, pageActive);
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
          const connection = connectionOwner.capture();
          if (!connection) {
            throw new Error("The session query is unavailable while disconnected. Try again.");
          }
          await refresh();
          check();
          if (!connectionOwner.isCurrent(connection)) {
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
    retire: retireWarmLists,
    get revision() {
      return invalidationRevision;
    },
    /** Fence active reads without invalidating the query supplying an accepted row. */
    invalidate(
      matches: (entry: ManagedSessionList) => boolean,
      activeQuery: SessionListScope,
      excludedKey?: string,
    ) {
      const key = JSON.stringify(normalizeManagedSessionListQuery(activeQuery));
      const active = managedLists.get(key);
      if (key !== excludedKey && (!active || matches(active))) {
        invalidationRevision += 1;
      }
      retireWarmLists((entry) => entry.key !== excludedKey && matches(entry));
    },
    /** Capture one accepted primary window without changing an observed query's membership. */
    capture(scope: SessionListScope, result: SessionsListResult, epoch: number) {
      const key = JSON.stringify(normalizeManagedSessionListQuery(scope));
      retireWarmLists((entry) => entry.scope.agentId === scope.agentId && entry.key !== key);
      const entry = open(scope);
      if (entry.listeners.size > 0 || entry.pending) {
        retireWarmLists((candidate) => candidate === entry);
        return;
      }
      entry.warmPrimary = true;
      entry.connectionEpoch = epoch;
      publishManagedList(entry, {
        result,
        agentId: scope.agentId ? normalizeAgentId(scope.agentId) : null,
        loading: false,
        error: null,
      });
    },
    /** Return only a live, unobserved, exact-query presentation lease. */
    presentation(
      query: SessionListScope,
      epoch: number,
    ): Pick<SessionListSnapshot, "result" | "agentId"> | null {
      if (!isPrimarySessionListQuery(query)) {
        return null;
      }
      for (const entry of managedLists.values()) {
        if (
          entry.warmPrimary &&
          entry.listeners.size === 0 &&
          !entry.pending &&
          !entry.snapshot.loading &&
          entry.snapshot.error === null &&
          entry.connectionEpoch === epoch &&
          isSameSessionListQuery(entry.scope, query, true)
        ) {
          return { result: entry.snapshot.result, agentId: entry.snapshot.agentId };
        }
      }
      return null;
    },
  };
}
