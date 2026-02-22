import type { GatewayBrowserClient } from "../gateway.ts";
import type { HealthSummary, ModelCatalogEntry, StatusSummary } from "../types.ts";
import { loadHealthState } from "./health.ts";
import { loadModels } from "./models.ts";

export type DebugState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSummary | null;
  debugModels: ModelCatalogEntry[];
  debugHeartbeat: unknown;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  /** Shared health state fields (written by {@link loadHealthState}). */
  healthLoading: boolean;
  healthResult: HealthSummary | null;
  healthError: string | null;
};

export async function loadDebug(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.debugLoading) {
    return;
  }
  state.debugLoading = true;
  try {
    const [status, , models, heartbeat] = await Promise.all([
      state.client.request("status", {}),
      loadHealthState(state),
      loadModels(state.client),
      state.client.request("last-heartbeat", {}),
    ]);
    state.debugStatus = status as StatusSummary;
    // Sync debugHealth from the shared healthResult for backward compat.
    state.debugHealth = state.healthResult;
    state.debugModels = models;
    state.debugHeartbeat = heartbeat;
  } catch (err) {
    state.debugCallError = String(err);
  } finally {
    state.debugLoading = false;
  }
}

export async function callDebugMethod(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
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
