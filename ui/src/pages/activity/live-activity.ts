import type { GatewaySessionRow } from "../../api/types.ts";
import { notifyGatewayObservers } from "../../app/gateway-observers.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { currentWorkIdentity } from "./current-work.ts";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

type LiveActivitySnapshot = {
  readonly entries: readonly ActivityEntry[];
  /** Retires page-local expansion and follow state without resetting it on each event. */
  readonly revision: number;
  readonly error: string | null;
};

export type LiveActivity = {
  readonly snapshot: LiveActivitySnapshot;
  subscribe: (listener: (snapshot: LiveActivitySnapshot) => void) => () => void;
  syncSessions: (rows: readonly GatewaySessionRow[]) => void;
  retry: () => void;
  clear: () => void;
  dispose: () => void;
};

export function createLiveActivity(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
): LiveActivity {
  let entries: ActivityEntry[] = [];
  let snapshot: LiveActivitySnapshot = { entries, revision: 0, error: null };
  const errors = new Map<string, string>();
  let eventLogRevision = gateway.eventLogRevision;
  let disposed = false;
  let rows: readonly GatewaySessionRow[] = [];
  let client = gateway.snapshot.client;
  let visible = document.visibilityState !== "hidden";
  const subscriptions = new Map<string, ReturnType<SessionCapability["subscribeMessages"]>>();
  const release = (key: string) => {
    const pending = subscriptions.get(key);
    subscriptions.delete(key);
    if (errors.delete(key)) {
      publish(entries);
    }
    const releaseClient = client;
    void pending?.then(
      (lease) =>
        sessions.unsubscribeMessages(lease).catch(() => {
          // A rejected final release retains the wire observer in the shared coordinator.
          if (gateway.snapshot.client === releaseClient && gateway.snapshot.phase === "connected") {
            gateway.connect();
          }
        }),
      () => undefined,
    );
  };
  const syncSubscriptions = () => {
    const connected = gateway.snapshot.phase === "connected";
    if (!connected) {
      rows = [];
    }
    const desired = new Map(
      (visible && connected && !disposed ? rows.slice(0, 100) : []).map((row) => [
        currentWorkIdentity({ key: row.key, agentId: row.agentId }),
        row,
      ]),
    );
    for (const key of subscriptions.keys()) {
      if (!desired.has(key) || client !== gateway.snapshot.client) {
        release(key);
      }
    }
    client = gateway.snapshot.client;
    for (const [key, row] of desired) {
      if (!subscriptions.has(key)) {
        const pending = sessions.subscribeMessages(row.key, {
          agentId: parseAgentSessionKey(row.key) ? undefined : row.agentId,
        });
        subscriptions.set(key, pending);
        void pending.catch((cause: unknown) => {
          if (subscriptions.get(key) === pending) {
            errors.set(key, cause instanceof Error ? cause.message : String(cause));
            publish(entries);
          }
        });
      }
    }
  };
  const handleVisibility = (event: Event) => {
    visible = event.type !== "pagehide" && document.visibilityState !== "hidden";
    syncSubscriptions();
  };
  document.addEventListener("visibilitychange", handleVisibility);
  globalThis.addEventListener("pagehide", handleVisibility);
  globalThis.addEventListener("pageshow", handleVisibility);
  const listeners = new Set<(snapshot: LiveActivitySnapshot) => void>();

  const publish = (next: ActivityEntry[], reset = false) => {
    const error = errors.values().next().value ?? null;
    if (next === entries && !reset && snapshot.error === error) {
      return;
    }
    entries = next;
    snapshot = { entries, revision: snapshot.revision + (reset ? 1 : 0), error };
    notifyGatewayObservers(
      listeners,
      snapshot,
      "activity",
      (current) => !disposed && current === snapshot,
    );
  };

  const retireChangedContext = () => {
    const revision = gateway.eventLogRevision;
    if (revision === eventLogRevision) {
      return;
    }
    eventLogRevision = revision;
    rows = [];
    syncSubscriptions();
    publish([], true);
  };

  const stopGateway = gateway.subscribe(() => {
    if (!disposed) {
      retireChangedContext();
      syncSubscriptions();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || (event.event !== "agent" && event.event !== "session.tool")) {
      return;
    }
    const eventClient = gateway.snapshot.client;
    const revision = gateway.eventLogRevision;
    retireChangedContext();
    if (
      disposed ||
      eventClient !== gateway.snapshot.client ||
      revision !== gateway.eventLogRevision
    ) {
      return;
    }
    const activityEvent = parseActivityEvent(event.payload, Date.now());
    if (
      activityEvent?.sessionKey &&
      subscriptions.has(
        currentWorkIdentity({ key: activityEvent.sessionKey, agentId: activityEvent.agentId }),
      )
    ) {
      publish(updateToolActivity(entries, activityEvent));
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncSessions(nextRows) {
      if (rows === nextRows) {
        return;
      }
      rows = nextRows;
      syncSubscriptions();
    },
    retry() {
      for (const key of errors.keys()) {
        release(key);
      }
      syncSubscriptions();
    },
    clear() {
      publish([], true);
    },
    dispose() {
      disposed = true;
      syncSubscriptions();
      document.removeEventListener("visibilitychange", handleVisibility);
      globalThis.removeEventListener("pagehide", handleVisibility);
      globalThis.removeEventListener("pageshow", handleVisibility);
      stopGateway();
      stopEvents();
      entries = [];
      snapshot = { entries, revision: snapshot.revision + 1, error: null };
      listeners.clear();
    },
  };
}
