import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";

type GatewaySnapshotInterest = "connection" | "authority";
type GatewaySnapshotListener = (snapshot: ApplicationGatewaySnapshot) => void;
type GatewaySnapshotObservation = {
  listeners: Record<GatewaySnapshotInterest, Set<GatewaySnapshotListener>>;
  stop: () => void;
};
const owners = new WeakMap<ApplicationGateway, GatewaySnapshotObservation>();

/** One subscription per Gateway; each consumer declares the facts that retire its work. */
export function subscribeGatewaySnapshot(
  gateway: ApplicationGateway,
  kind: GatewaySnapshotInterest,
  listener: GatewaySnapshotListener,
): () => void {
  let owner = owners.get(gateway);
  if (!owner) {
    const listeners: GatewaySnapshotObservation["listeners"] = {
      connection: new Set(),
      authority: new Set(),
    };
    let client = gateway.snapshot.client;
    let connected = gateway.snapshot.phase === "connected";
    let revision = gateway.connectionRevision;
    let generation = client?.connectionGeneration ?? -1;
    let hello = gateway.snapshot.hello;
    let auth = JSON.stringify(hello?.auth ?? null);
    let methods = JSON.stringify(hello?.features?.methods ?? null);
    const pending = { connection: false, authority: false };
    const stop = gateway.subscribe((snapshot) => {
      const nextConnected = snapshot.phase === "connected";
      const nextRevision = gateway.connectionRevision;
      const nextGeneration = snapshot.client?.connectionGeneration ?? -1;
      const nextAuth = JSON.stringify(snapshot.hello?.auth ?? null);
      const nextMethods = JSON.stringify(snapshot.hello?.features?.methods ?? null);
      const connectionChanged = client !== snapshot.client || connected !== nextConnected;
      const authorityChanged =
        connectionChanged ||
        revision !== nextRevision ||
        generation !== nextGeneration ||
        auth !== nextAuth ||
        hello !== snapshot.hello ||
        methods !== nextMethods;
      client = snapshot.client;
      connected = nextConnected;
      revision = nextRevision;
      generation = nextGeneration;
      auth = nextAuth;
      hello = snapshot.hello;
      methods = nextMethods;
      pending.connection ||= connectionChanged;
      pending.authority ||= authorityChanged;
      for (const target of ["connection", "authority"] as const) {
        if (!pending[target]) {
          continue;
        }
        for (const callback of Array.from(listeners[target])) {
          // Match Gateway publication ordering, including a nested replacement.
          if (gateway.snapshot !== snapshot) {
            return;
          }
          if (listeners[target].has(callback)) {
            try {
              callback(snapshot);
            } catch (error) {
              reportError(error);
            }
          }
        }
        pending[target] = false;
      }
    });
    owner = { listeners, stop };
    owners.set(gateway, owner);
  }
  const current = owner;
  const entry: GatewaySnapshotListener = (snapshot) => listener(snapshot);
  current.listeners[kind].add(entry);
  return () => {
    if (
      current.listeners[kind].delete(entry) &&
      current.listeners.connection.size === 0 &&
      current.listeners.authority.size === 0
    ) {
      current.stop();
      owners.delete(gateway);
    }
  };
}
