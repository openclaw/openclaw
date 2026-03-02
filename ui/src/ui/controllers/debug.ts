import type { GatewayBrowserClient } from "../gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../types.ts";

export type DebugState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
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
    const [status, health, channels, models, heartbeat] = await Promise.all([
      state.client.request("status", {}),
      state.client.request("health", {}),
      state.client.request("channels.status", { probe: false, timeoutMs: 8000 }),
      state.client.request("models.list", {}),
      state.client.request("last-heartbeat", {}),
    ]);
    state.debugStatus = status as StatusSummary;

    const debugHealth = health as HealthSnapshot;
    const channelsSnapshot = channels as
      | { channels?: Record<string, { running?: boolean; lastStartAt?: number | null }> }
      | null
      | undefined;
    const telegramRuntime = channelsSnapshot?.channels?.telegram;
    const telegramHealth = (debugHealth?.channels as Record<string, unknown> | undefined)
      ?.telegram as Record<string, unknown> | undefined;
    if (telegramHealth && telegramRuntime) {
      if (typeof telegramRuntime.running === "boolean") {
        telegramHealth.running = telegramRuntime.running;
      }
      if (telegramRuntime.lastStartAt != null) {
        telegramHealth.lastStartAt = telegramRuntime.lastStartAt;
      }
    }

    state.debugHealth = debugHealth;
    const modelPayload = models as { models?: unknown[] } | undefined;
    state.debugModels = Array.isArray(modelPayload?.models) ? modelPayload?.models : [];
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
