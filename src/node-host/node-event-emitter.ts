// Process-level registry that lets node-host plugins (e.g. the browser
// extension bridge) emit an AUTHENTICATED node→gateway event without holding the
// node's GatewayClient directly.
//
// The node-host runner registers an emitter (bound to its live GatewayClient)
// once the node connection is up, and clears it on close. A plugin running in
// the same node-host process — e.g. the extension bridge started lazily by the
// browser proxy command — calls `emitNodeGatewayEvent(...)` to originate a
// node-attributed event such as `agent.request`. Because the event travels on
// the node's own cryptographically-paired connection, the gateway records the
// authenticated nodeId for the resulting turn (enabling gateway.tools.byNode),
// and a client cannot forge it.

type NodeGatewayEventEmitter = (event: string, payload: unknown) => Promise<void>;

let emitter: NodeGatewayEventEmitter | null = null;

/** Register (or, with null, clear) the node-host's authenticated event emitter. */
export function registerNodeGatewayEventEmitter(fn: NodeGatewayEventEmitter | null): void {
  emitter = fn;
}

/** True when a node-host connection is up and can originate node→gateway events. */
export function hasNodeGatewayEventEmitter(): boolean {
  return emitter !== null;
}

/**
 * Emit a node→gateway event over the node-host's authenticated connection.
 * Throws if no node-host connection is registered (caller should surface this to
 * the requester rather than silently dropping a turn).
 */
export async function emitNodeGatewayEvent(event: string, payload: unknown): Promise<void> {
  const current = emitter;
  if (!current) {
    throw new Error("node-host gateway event emitter is not registered");
  }
  await current(event, payload);
}
