import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayStatus =
  | "connecting"
  | "starting"
  | "restarting"
  | "suspending"
  | "suspended"
  | "reconnecting"
  | "restoring"
  | "reload-required"
  | "offline";

export type GatewayStatusSnapshot = Pick<
  ApplicationGatewaySnapshot,
  "phase" | "offlineStable" | "restartPending" | "suspensionPhase"
> & {
  client: Pick<GatewayBrowserClient, "recoveryScopeReady"> | null;
};

export function resolveGatewayStatus(
  snapshot: GatewayStatusSnapshot,
  refreshRequired = false,
): GatewayStatus | null {
  if (refreshRequired || snapshot.phase === "reload-required") {
    return "reload-required";
  }
  if (snapshot.restartPending) {
    return "restarting";
  }
  if (snapshot.suspensionPhase === "preparing" || snapshot.suspensionPhase === "draining") {
    return "suspending";
  }
  if (snapshot.suspensionPhase === "prepared") {
    return "suspended";
  }
  if (snapshot.phase === "connecting" || snapshot.phase === "starting") {
    return snapshot.phase;
  }
  if (snapshot.phase === "connected") {
    return snapshot.client?.recoveryScopeReady === false ? "restoring" : null;
  }
  if (snapshot.offlineStable) {
    return snapshot.phase === "reconnecting" ? "reconnecting" : "offline";
  }
  return null;
}
