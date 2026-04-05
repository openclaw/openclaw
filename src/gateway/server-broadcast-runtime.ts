import type { GatewayBroadcastFn } from "./server-broadcast.js";

const GATEWAY_BROADCAST_RUNTIME_KEY = Symbol.for("openclaw.gatewayBroadcastRuntime");

type GatewayBroadcastRuntimeState = {
  broadcast: GatewayBroadcastFn | null;
};

function getGatewayBroadcastRuntimeState(): GatewayBroadcastRuntimeState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[GATEWAY_BROADCAST_RUNTIME_KEY];
  if (existing && typeof existing === "object") {
    return existing as GatewayBroadcastRuntimeState;
  }
  const created: GatewayBroadcastRuntimeState = { broadcast: null };
  globalRecord[GATEWAY_BROADCAST_RUNTIME_KEY] = created;
  return created;
}

export function setGatewayBroadcastRuntime(broadcast: GatewayBroadcastFn | null): void {
  getGatewayBroadcastRuntimeState().broadcast = broadcast;
}

export function getGatewayBroadcastRuntime(): GatewayBroadcastFn | null {
  return getGatewayBroadcastRuntimeState().broadcast;
}
