import type { ApplicationGateway } from "../../../app/gateway.ts";
import { listen } from "../../../lib/reactive/listener.ts";

type CardUpdate = (force: boolean) => void;
type CardUpdates = {
  listeners: Set<CardUpdate>;
  stop: () => void;
};
const owners = new WeakMap<ApplicationGateway, Map<Document, CardUpdates>>();

/** Share wakeups; each card retains synchronous request retirement and publication authority. */
export function subscribeClawHubCardUpdates(
  gateway: ApplicationGateway,
  document: Document,
  listener: CardUpdate,
): () => void {
  let documents = owners.get(gateway);
  if (!documents) {
    documents = new Map();
    owners.set(gateway, documents);
  }
  let owner = documents.get(document);
  if (!owner) {
    const listeners = new Set<CardUpdate>();
    let client = gateway.snapshot.client;
    let connected = gateway.snapshot.phase === "connected";
    let pluginGeneration = gateway.snapshot.pluginCapabilities?.generation;
    let pendingGatewayUpdate = false;
    const notify = (force: boolean, current: () => boolean) => {
      for (const callback of Array.from(listeners)) {
        if (!current()) {
          return false;
        }
        if (listeners.has(callback)) {
          try {
            callback(force);
          } catch (error) {
            reportError(error);
          }
        }
      }
      return true;
    };
    const stopGateway = gateway.subscribe((snapshot) => {
      const nextConnected = snapshot.phase === "connected";
      const nextPluginGeneration = snapshot.pluginCapabilities?.generation;
      // These are exactly the shared inputs read by each card's load admission.
      const changed =
        client !== snapshot.client ||
        connected !== nextConnected ||
        pluginGeneration !== nextPluginGeneration;
      client = snapshot.client;
      connected = nextConnected;
      pluginGeneration = nextPluginGeneration;
      if (changed || pendingGatewayUpdate) {
        // Match Gateway delivery: a callback may synchronously replace this publication.
        pendingGatewayUpdate = true;
        if (notify(false, () => gateway.snapshot === snapshot)) {
          pendingGatewayUpdate = false;
        }
      }
    });
    const activate = () =>
      notify(
        true,
        () => gateway.snapshot.phase === "connected" && document.visibilityState === "visible",
      );
    const stopVisibility = listen(document, "visibilitychange", activate);
    const stopFocus = document.defaultView && listen(document.defaultView, "focus", activate);
    owner = {
      listeners,
      stop: () => {
        stopGateway();
        stopVisibility();
        stopFocus?.();
      },
    };
    documents.set(document, owner);
  }
  const current = owner;
  const entry: CardUpdate = (force) => listener(force);
  current.listeners.add(entry);
  return () => {
    if (current.listeners.delete(entry) && current.listeners.size === 0) {
      current.stop();
      documents.delete(document);
      if (documents.size === 0) {
        owners.delete(gateway);
      }
    }
  };
}
