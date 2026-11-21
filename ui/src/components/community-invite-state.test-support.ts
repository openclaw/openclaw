import type { ApplicationContext } from "../app/context-types.ts";
import type { SessionListScope, SessionListSnapshot } from "../lib/sessions/session-capability.ts";

type SessionUse = number | "failed";

function listSnapshot(used: SessionUse | undefined): SessionListSnapshot {
  if (used === undefined) {
    return { result: null, agentId: null, loading: false, error: null };
  }
  if (used === "failed") {
    return {
      result: null,
      agentId: null,
      loading: false,
      error: "Gateway unavailable",
      readSucceeded: false,
    };
  }
  return {
    result: {
      ts: 1,
      path: "(multiple)",
      count: 0,
      totalCount: used,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    },
    agentId: null,
    loading: false,
    error: null,
    readSucceeded: true,
    pagination: { count: 0, totalCount: used },
  };
}

/** Session-use source with the managed-list read contract the invitation relies on. */
export function createCommunityInviteContext(options: {
  used: SessionUse;
  retained?: number;
  connected?: boolean;
}) {
  let connected = options.connected ?? true;
  let epoch = 0;
  let reads = 0;
  const queries: SessionListScope[] = [];
  const tasks: Promise<unknown>[] = [];
  const gatewayListeners = new Set<() => void>();
  const listListeners = new Set<(snapshot: SessionListSnapshot) => void>();
  const sessions = {
    captureConnectionScope: () => (connected ? { epoch } : null),
    isConnectionScopeCurrent: (scope: { epoch: number }) => connected && scope.epoch === epoch,
    observeList(scope: SessionListScope, listener: (snapshot: SessionListSnapshot) => void) {
      queries.push(scope);
      listListeners.add(listener);
      // Managed lists replay their retained snapshot before the explicit refresh settles.
      listener(listSnapshot(options.retained));
      return {
        async refresh() {
          reads += 1;
          listener(listSnapshot(options.used));
          if (options.used === "failed") {
            throw new Error("Gateway unavailable");
          }
        },
        dispose: () => listListeners.delete(listener),
      };
    },
  };
  const context = {
    sessions,
    gateway: {
      subscribe(listener: () => void) {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    connectionBootstrap: {
      run: (_key: unknown, task: () => Promise<unknown>) => {
        const run = task();
        tasks.push(run);
        return run;
      },
    },
    // SAFETY: The fake implements every member the session-use observer reads.
  } as unknown as Pick<ApplicationContext, "gateway" | "sessions" | "connectionBootstrap">;
  return {
    context,
    queries,
    get reads() {
      return reads;
    },
    observing: () => listListeners.size > 0,
    /** Resolves after every started session-use read has been accepted or rejected. */
    settled: () => Promise.all(tasks),
    publish(next: { used: SessionUse }) {
      for (const listener of listListeners) {
        listener(listSnapshot(next.used));
      }
    },
    connect() {
      connected = true;
      epoch += 1;
      for (const listener of gatewayListeners) {
        listener();
      }
    },
  };
}
