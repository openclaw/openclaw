import { notifyGatewayObservers } from "../../app/gateway-observers.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

type LiveActivitySnapshot = {
  readonly entries: readonly ActivityEntry[];
  /** Retires page-local expansion and follow state without resetting it on each event. */
  readonly revision: number;
};

export type LiveActivity = {
  readonly snapshot: LiveActivitySnapshot;
  subscribe: (listener: (snapshot: LiveActivitySnapshot) => void) => () => void;
  clear: () => void;
  dispose: () => void;
};

export function createLiveActivity(gateway: ApplicationGateway): LiveActivity {
  let entries: ActivityEntry[] = [];
  let snapshot: LiveActivitySnapshot = { entries, revision: 0 };
  let eventLogRevision = gateway.eventLogRevision;
  let disposed = false;
  const listeners = new Set<(snapshot: LiveActivitySnapshot) => void>();

  const publish = (next: ActivityEntry[], reset = false) => {
    if (next === entries && !reset) {
      return;
    }
    entries = next;
    snapshot = { entries, revision: snapshot.revision + (reset ? 1 : 0) };
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
    publish([], true);
  };

  // Bootstrap attaches Activity before starting the Gateway; it owns its reduced history.
  const stopGateway = gateway.subscribe(() => {
    if (!disposed) {
      retireChangedContext();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || (event.event !== "agent" && event.event !== "session.tool")) {
      return;
    }
    const client = gateway.snapshot.client;
    const revision = gateway.eventLogRevision;
    retireChangedContext();
    if (disposed || client !== gateway.snapshot.client || revision !== gateway.eventLogRevision) {
      return;
    }
    const activityEvent = parseActivityEvent(event.payload, Date.now());
    if (activityEvent) {
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
    clear() {
      publish([], true);
    },
    dispose() {
      disposed = true;
      stopGateway();
      stopEvents();
      entries = [];
      snapshot = { entries, revision: snapshot.revision + 1 };
      listeners.clear();
    },
  };
}
