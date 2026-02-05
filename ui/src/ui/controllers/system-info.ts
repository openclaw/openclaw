import type { GatewayBrowserClient } from "../gateway.ts";

export type SystemInfoResult = {
  pid: number;
  version: string;
  host: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  storage: { backend: "postgresql" | "sqlite" | "memory"; details?: string };
  cache: { backend: "redis" | "memory"; host?: string; port?: number };
  model: string;
  browserProfiles: number | null;
  logFile: string;
};

export type SystemInfoState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  systemInfo: SystemInfoResult | null;
  systemInfoLoading: boolean;
  systemInfoError: string | null;
};

export async function loadSystemInfo(state: SystemInfoState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.systemInfoLoading) {
    return;
  }
  state.systemInfoLoading = true;
  state.systemInfoError = null;
  try {
    const result = await state.client.request<SystemInfoResult | undefined>("system.info", {});
    if (result) {
      state.systemInfo = result;
    }
  } catch (err) {
    state.systemInfoError = String(err);
  } finally {
    state.systemInfoLoading = false;
  }
}
