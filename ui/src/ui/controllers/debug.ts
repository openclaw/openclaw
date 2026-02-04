<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
import type { HealthSnapshot, StatusSummary } from "../types";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../types.ts";
>>>>>>> upstream/main

export type DebugState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
<<<<<<< HEAD
  debugHeartbeat: unknown | null;
=======
  debugHeartbeat: unknown;
>>>>>>> upstream/main
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
};

export async function loadDebug(state: DebugState) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  if (state.debugLoading) return;
=======
  if (!state.client || !state.connected) {
    return;
  }
  if (state.debugLoading) {
    return;
  }
>>>>>>> upstream/main
  state.debugLoading = true;
  try {
    const [status, health, models, heartbeat] = await Promise.all([
      state.client.request("status", {}),
      state.client.request("health", {}),
      state.client.request("models.list", {}),
      state.client.request("last-heartbeat", {}),
    ]);
    state.debugStatus = status as StatusSummary;
    state.debugHealth = health as HealthSnapshot;
    const modelPayload = models as { models?: unknown[] } | undefined;
    state.debugModels = Array.isArray(modelPayload?.models) ? modelPayload?.models : [];
<<<<<<< HEAD
    state.debugHeartbeat = heartbeat as unknown;
=======
    state.debugHeartbeat = heartbeat;
>>>>>>> upstream/main
  } catch (err) {
    state.debugCallError = String(err);
  } finally {
    state.debugLoading = false;
  }
}

export async function callDebugMethod(state: DebugState) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
=======
  if (!state.client || !state.connected) {
    return;
  }
>>>>>>> upstream/main
  state.debugCallError = null;
  state.debugCallResult = null;
  try {
    const params = state.debugCallParams.trim()
      ? (JSON.parse(state.debugCallParams) as unknown)
      : {};
    const res = await state.client.request(state.debugCallMethod.trim(), params);
    state.debugCallResult = JSON.stringify(res, null, 2);
  } catch (err) {
    state.debugCallError = String(err);
  }
}
