import { WebSocket } from "ws";
import type { HealthSummary } from "../../commands/health.js";
import type { GatewayConnectionHealthState, GatewayWsClient } from "./ws-types.js";

export const CONNECTION_PING_INTERVAL_MS = 5_000;
// 4x stale tolerance: misses up to 3 pongs before reporting disconnected.
export const CONNECTION_STALE_MS = CONNECTION_PING_INTERVAL_MS * 4;

export function pingGatewayClient(client: GatewayWsClient, now = Date.now()): boolean {
  if (client.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  client.connectionHealth.lastPingSentAtMs = now;
  try {
    client.socket.ping(String(now));
    return true;
  } catch {
    return false;
  }
}

export function recordConnectionPong(
  client: GatewayWsClient | null | undefined,
  data: Buffer,
  now = Date.now(),
): boolean {
  if (!client) {
    return false;
  }
  // We only use pongs that echo our own numeric ping payload.
  const sentAt = Number(data.toString());
  if (!Number.isFinite(sentAt) || sentAt !== client.connectionHealth.lastPingSentAtMs) {
    return false;
  }

  const sample = Math.max(0, now - sentAt);
  const prev = client.connectionHealth.rttMs;
  client.connectionHealth.rttMs =
    prev === undefined ? sample : Math.round(prev * 0.8 + sample * 0.2);
  client.connectionHealth.lastHeartbeatAtMs = now;
  return true;
}

export function withConnectionHealth(
  snap: HealthSummary,
  client?: {
    socket?: { readyState: number };
    connectionHealth?: GatewayConnectionHealthState;
  } | null,
  now = Date.now(),
): HealthSummary {
  const lastHeartbeatAt = client?.connectionHealth?.lastHeartbeatAtMs ?? null;
  const connectedAt = client?.connectionHealth?.connectedAtMs ?? null;
  const socketOpen = client?.socket?.readyState === WebSocket.OPEN;
  const fresh =
    lastHeartbeatAt !== null
      ? now - lastHeartbeatAt <= CONNECTION_STALE_MS
      : connectedAt !== null && now - connectedAt <= CONNECTION_STALE_MS;

  return {
    ...snap,
    connection: {
      connected: socketOpen && fresh,
      rttMs: client?.connectionHealth?.rttMs ?? null,
      lastHeartbeatAt,
    },
  };
}
