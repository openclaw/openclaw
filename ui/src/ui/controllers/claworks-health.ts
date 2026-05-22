import {
  createIdleClaworksHealthSnapshot,
  gatewayUrlToHttpOrigin,
  isClaworksRobotPluginActive,
  probeClaworksHealth,
  readClaworksApiKey,
  readClaworksRequireApiKey,
  resolveClaworksRobotPluginConfig,
  type ClaworksHealthSnapshot,
} from "../claworks-health.ts";
import type { UiSettings } from "../storage.ts";
import type { ConfigSnapshot } from "../types.ts";

export type ClaworksHealthState = {
  claworksHealth: ClaworksHealthSnapshot;
};

export async function loadClaworksHealthState(
  host: ClaworksHealthState & {
    configSnapshot: ConfigSnapshot | null;
    settings: UiSettings;
    password?: string;
  },
): Promise<void> {
  const enabled = isClaworksRobotPluginActive(host.configSnapshot);
  if (!enabled) {
    host.claworksHealth = createIdleClaworksHealthSnapshot();
    return;
  }

  const pluginConfig = resolveClaworksRobotPluginConfig(host.configSnapshot);
  const apiKey = readClaworksApiKey(pluginConfig);
  const requireApiKey = readClaworksRequireApiKey(pluginConfig);
  const httpOrigin = gatewayUrlToHttpOrigin(host.settings.gatewayUrl);

  host.claworksHealth = {
    enabled: true,
    loading: true,
    error: null,
    httpOrigin,
    hasApiKey: Boolean(apiKey),
    requireApiKey,
    lastCheckedAt: null,
    payload: null,
    httpStatus: null,
  };

  if (!httpOrigin) {
    host.claworksHealth = {
      ...host.claworksHealth,
      loading: false,
      error: "Invalid gateway URL — use ws://127.0.0.1:18800 (ClaWorks) or http(s) origin.",
    };
    return;
  }

  const result = await probeClaworksHealth({
    httpOrigin,
    apiKey: apiKey || undefined,
    gatewayToken: host.settings.token.trim() || undefined,
  });

  host.claworksHealth = {
    ...host.claworksHealth,
    loading: false,
    lastCheckedAt: Date.now(),
    httpStatus: result.httpStatus,
    payload: result.payload,
    error: result.error,
  };
}
