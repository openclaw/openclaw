import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

/** Keyless withdrawal remains deliverable after the reader loses session visibility. */
export function invalidatePrReader(connId: string, broadcast: GatewayBroadcastToConnIdsFn): void {
  broadcast("sessions.changed", { reason: "profile-identity" }, new Set([connId]));
}
