import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

/** Keyless withdrawal remains deliverable after the reader loses session visibility. */
export function invalidatePrReader(connId: string, broadcast: GatewayBroadcastToConnIdsFn): void {
  broadcast("sessions.changed", { reason: "profile-identity" }, new Set([connId]));
}

/** Serialize snapshots so an older delivery cannot overtake its replacement. */
export function enqueuePrDelivery(
  owner: { delivery?: Promise<void> },
  deliver: () => Promise<void>,
): Promise<void> {
  const delivery = (owner.delivery ?? Promise.resolve()).then(deliver).finally(() => {
    if (owner.delivery === delivery) {
      delete owner.delivery;
    }
  });
  owner.delivery = delivery;
  return delivery;
}
