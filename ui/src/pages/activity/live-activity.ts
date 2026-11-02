import type { GatewaySessionRow } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { listen } from "../../lib/reactive/listener.ts";
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

export function createLiveActivity(gateway: ApplicationGateway, sessions: SessionCapability) {
  let entries: ActivityEntry[] = [];
  let snapshot: LiveActivitySnapshot = { entries, revision: 0, error: null };
  const errors = new Map<string, string>();
  let eventLogRevision = gateway.eventLogRevision;
  let presentationScope = gatewayPresentationScope(gateway);
  let disposed = false;
  let rows: readonly GatewaySessionRow[] = [];
  let client = gateway.snapshot.client;
  let visible = document.visibilityState !== "hidden";
  let pendingEvents: NonNullable<ReturnType<typeof parseActivityEvent>>[] = [];
  let scheduledFlush: ReturnType<typeof setTimeout> | undefined;
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
    flushPending();
    visible = event.type !== "pagehide" && document.visibilityState !== "hidden";
    syncSubscriptions();
  };
  const stopVisibility = listen(document, "visibilitychange", handleVisibility);
  const stopPageHide = listen(globalThis, "pagehide", handleVisibility);
  const stopPageShow = listen(globalThis, "pageshow", handleVisibility);
  let render: ((snapshot: LiveActivitySnapshot) => void) | undefined;

  const publish = (next: ActivityEntry[], reset = false) => {
    const error = errors.values().next().value ?? null;
    if (next === entries && !reset && snapshot.error === error) {
      return;
    }
    entries = next;
    snapshot = { entries, revision: snapshot.revision + (reset ? 1 : 0), error };
    if (!disposed) {
      try {
        render?.(snapshot);
      } catch (handlerError) {
        console.error("[gateway] activity handler error:", handlerError);
      }
    }
  };

  const cancelFlush = () => {
    if (scheduledFlush !== undefined) {
      clearTimeout(scheduledFlush);
      scheduledFlush = undefined;
    }
  };
  const flushPending = () => {
    cancelFlush();
    if (pendingEvents.length === 0) {
      return;
    }
    const batch = pendingEvents;
    pendingEvents = [];
    let next = entries;
    for (const event of batch) {
      next = updateToolActivity(next, event);
    }
    publish(next);
  };

  const retireChangedContext = () => {
    const revision = gateway.eventLogRevision;
    const nextPresentationScope = gatewayPresentationScope(gateway);
    if (revision === eventLogRevision && nextPresentationScope === presentationScope) {
      return;
    }
    eventLogRevision = revision;
    presentationScope = nextPresentationScope;
    pendingEvents = [];
    cancelFlush();
    rows = [];
    syncSubscriptions();
    publish([], true);
  };

  // Every connection transition retires stale activity and rebinds the owned message leases synchronously.
  const stopGateway = gateway.subscribe(() => {
    if (!disposed) {
      retireChangedContext();
      flushPending();
      syncSubscriptions();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || (event.event !== "agent" && event.event !== "session.tool")) {
      return;
    }
    const eventClient = gateway.snapshot.client;
    const revision = gateway.eventLogRevision;
    const eventPresentationScope = gatewayPresentationScope(gateway);
    retireChangedContext();
    if (
      disposed ||
      eventClient !== gateway.snapshot.client ||
      eventPresentationScope !== gatewayPresentationScope(gateway) ||
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
      // Admission stays synchronous and ordered. Only this feed's presentation
      // work moves off transport delivery; chat/sidebar still receive every event.
      // A task boundary yields without waiting an extra display frame in WebKit.
      pendingEvents.push(activityEvent);
      scheduledFlush ??= setTimeout(() => {
        scheduledFlush = undefined;
        retireChangedContext();
        flushPending();
      }, 0);
    }
  });

  return {
    get snapshot() {
      // Plain owner callers retain synchronous mutate-then-read semantics.
      flushPending();
      return snapshot;
    },
    subscribe(listener: (snapshot: LiveActivitySnapshot) => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
    syncSessions(nextRows: readonly GatewaySessionRow[]) {
      if (rows === nextRows) {
        return;
      }
      flushPending();
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
      pendingEvents = [];
      cancelFlush();
      publish([], true);
    },
    dispose() {
      disposed = true;
      pendingEvents = [];
      cancelFlush();
      syncSubscriptions();
      stopVisibility();
      stopPageHide();
      stopPageShow();
      stopGateway();
      stopEvents();
      entries = [];
      snapshot = { entries, revision: snapshot.revision + 1, error: null };
      render = undefined;
    },
  };
}
