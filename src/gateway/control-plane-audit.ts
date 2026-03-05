import type { GatewayClient } from "./server-methods/types.js";

export type ControlPlaneActor = {
  actor: string;
  deviceId: string;
  clientIp: string;
  connId: string;
};

function normalizePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveControlPlaneActor(client: GatewayClient | null): ControlPlaneActor {
  return {
    actor: normalizePart(client?.connect?.client?.id, "unknown-actor"),
    deviceId: normalizePart(client?.connect?.device?.id, "unknown-device"),
    clientIp: normalizePart(client?.clientIp, "unknown-ip"),
    connId: normalizePart(client?.connId, "unknown-conn"),
  };
}

export function formatControlPlaneActor(actor: ControlPlaneActor): string {
  return `actor=${actor.actor} device=${actor.deviceId} ip=${actor.clientIp} conn=${actor.connId}`;
}

export function summarizeChangedPaths(paths: string[], maxPaths = 8): string {
  if (paths.length === 0) {
    return "<none>";
  }
  if (paths.length <= maxPaths) {
    return paths.join(",");
  }
  const head = paths.slice(0, maxPaths).join(",");
  return `${head},+${paths.length - maxPaths} more`;
}
