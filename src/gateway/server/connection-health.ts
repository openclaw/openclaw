import { WebSocket } from "ws";
import type { HealthSummary } from "../../commands/health.js";
import type { GatewayConnectionHealthState, GatewayWsClient } from "./ws-types.js";

export const CONNECTION_PING_INTERVAL_MS = 5_000;
// 4x stale tolerance: misses up to 3 pongs before reporting disconnected.
export const CONNECTION_STALE_MS = CONNECTION_PING_INTERVAL_MS * 4;
const MAX_PENDING_PING_TIMESTAMPS =
  Math.ceil(CONNECTION_STALE_MS / CONNECTION_PING_INTERVAL_MS) + 1;

function isFreshPingTimestamp(sentAt: number, now: number): boolean {
  return sentAt <= now && now - sentAt <= CONNECTION_STALE_MS;
}

function prunePendingPingTimestamps(state: GatewayConnectionHealthState, now: number): number[] {
  const pending =
    state.pendingPingSentAtMs?.filter((sentAt) => isFreshPingTimestamp(sentAt, now)) ?? [];
  if (pending.length > 0) {
    state.pendingPingSentAtMs = pending.slice(-MAX_PENDING_PING_TIMESTAMPS);
    return state.pendingPingSentAtMs;
  }
  delete state.pendingPingSentAtMs;
  return [];
}

export function pingGatewayClient(client: GatewayWsClient, now = Date.now()): boolean {
  if (client.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    client.socket.ping(String(now));
    const pending = prunePendingPingTimestamps(client.connectionHealth, now);
    pending.push(now);
    client.connectionHealth.pendingPingSentAtMs = pending.slice(-MAX_PENDING_PING_TIMESTAMPS);
    client.connectionHealth.lastPingSentAtMs = now;
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
  if (!Number.isFinite(sentAt) || !isFreshPingTimestamp(sentAt, now)) {
    return false;
  }
  const pending = prunePendingPingTimestamps(client.connectionHealth, now);
  const tracked = sentAt === client.connectionHealth.lastPingSentAtMs || pending.includes(sentAt);
  if (!tracked) {
    return false;
  }

  const sample = Math.max(0, now - sentAt);
  const prev = client.connectionHealth.rttMs;
  client.connectionHealth.rttMs =
    prev === undefined ? sample : Math.round(prev * 0.8 + sample * 0.2);
  client.connectionHealth.lastHeartbeatAtMs = now;
  client.connectionHealth.pendingPingSentAtMs = pending.filter((value) => value !== sentAt);
  if (client.connectionHealth.pendingPingSentAtMs.length === 0) {
    delete client.connectionHealth.pendingPingSentAtMs;
  }
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
