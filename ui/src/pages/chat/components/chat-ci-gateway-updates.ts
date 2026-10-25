import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../../app/gateway.ts";

type CiGatewayKind = "details" | "automation";
type CiGatewayListener = (snapshot: ApplicationGatewaySnapshot) => void;
type CiGatewayUpdates = {
  listeners: Record<CiGatewayKind, Set<CiGatewayListener>>;
  stop: () => void;
};
const owners = new WeakMap<ApplicationGateway, CiGatewayUpdates>();

/** Filter shared facts once; CI owners retain synchronous request and write retirement. */
export function subscribeCiGatewayUpdates(
  gateway: ApplicationGateway,
  kind: CiGatewayKind,
  listener: CiGatewayListener,
): () => void {
  let owner = owners.get(gateway);
  if (!owner) {
    const listeners: CiGatewayUpdates["listeners"] = {
      details: new Set(),
      automation: new Set(),
    };
    let client = gateway.snapshot.client;
    let connected = gateway.snapshot.phase === "connected";
    let revision = gateway.connectionRevision;
    let generation = client?.connectionGeneration ?? -1;
    let auth = JSON.stringify(gateway.snapshot.hello?.auth ?? null);
    const pending = { details: false, automation: false };
    const stop = gateway.subscribe((snapshot) => {
      const nextConnected = snapshot.phase === "connected";
      const nextRevision = gateway.connectionRevision;
      const nextGeneration = snapshot.client?.connectionGeneration ?? -1;
      const nextAuth = JSON.stringify(snapshot.hello?.auth ?? null);
      const connectionChanged = client !== snapshot.client || connected !== nextConnected;
      const automationChanged =
        connectionChanged ||
        revision !== nextRevision ||
        generation !== nextGeneration ||
        auth !== nextAuth;
      client = snapshot.client;
      connected = nextConnected;
      revision = nextRevision;
      generation = nextGeneration;
      auth = nextAuth;
      pending.details ||= connectionChanged;
      pending.automation ||= automationChanged;
      for (const target of ["details", "automation"] as const) {
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
  const entry: CiGatewayListener = (snapshot) => listener(snapshot);
  current.listeners[kind].add(entry);
  return () => {
    if (
      current.listeners[kind].delete(entry) &&
      current.listeners.details.size === 0 &&
      current.listeners.automation.size === 0
    ) {
      current.stop();
      owners.delete(gateway);
    }
  };
}
