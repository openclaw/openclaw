import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

export function broadcastRejectedDevicePairing(
  broadcast: GatewayBroadcastFn,
  pairing: { requestId: string; deviceId: string },
  ts: number,
): void {
  const { requestId, deviceId } = pairing;
  broadcast(
    "device.pair.resolved",
    { requestId, deviceId, decision: "rejected", ts },
    { dropIfSlow: true },
  );
}

export function broadcastRejectedNodePairing(
  broadcast: GatewayBroadcastFn,
  pairing: { requestId: string; nodeId: string },
  ts: number,
): void {
  const { requestId, nodeId } = pairing;
  broadcast(
    "node.pair.resolved",
    { requestId, nodeId, decision: "rejected", ts },
    { dropIfSlow: true },
  );
}
