import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";
import type { ConfigSnapshot } from "./types.ts";

export const CLAWORKS_ROBOT_PLUGIN_ID = "claworks-robot";

export type ClaworksHealthPayload = {
  status?: string;
  robot?: string;
  role?: string;
  version?: string;
  kb_provider?: string;
  kb_vector?: boolean;
  kb_embed_model?: string;
  uptime_s?: number;
  planes?: Record<string, string>;
  checks?: Array<{ id: string; status: string; message?: string | null }>;
};

export type ClaworksHealthSnapshot = {
  enabled: boolean;
  loading: boolean;
  error: string | null;
  httpOrigin: string | null;
  hasApiKey: boolean;
  requireApiKey: boolean;
  lastCheckedAt: number | null;
  payload: ClaworksHealthPayload | null;
  httpStatus: number | null;
};

export function createIdleClaworksHealthSnapshot(): ClaworksHealthSnapshot {
  return {
    enabled: false,
    loading: false,
    error: null,
    httpOrigin: null,
    hasApiKey: false,
    requireApiKey: false,
    lastCheckedAt: null,
    payload: null,
    httpStatus: null,
  };
}

export function isClaworksRobotPluginActive(
  configSnapshot: ConfigSnapshot | null | undefined,
): boolean {
  return isPluginEnabledInConfigSnapshot(configSnapshot, CLAWORKS_ROBOT_PLUGIN_ID, {
    enabledByDefault: true,
  });
}

export function resolveClaworksRobotPluginConfig(
  configSnapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  const config = configSnapshot?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const plugins = (config as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return null;
  }
  const entries = (plugins as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return null;
  }
  const entry = (entries as Record<string, unknown>)[CLAWORKS_ROBOT_PLUGIN_ID];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const pluginConfig = (entry as { config?: unknown }).config;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return {};
  }
  return pluginConfig as Record<string, unknown>;
}

export function readClaworksApiKey(pluginConfig: Record<string, unknown> | null): string {
  const api = pluginConfig?.api;
  if (!api || typeof api !== "object" || Array.isArray(api)) {
    return "";
  }
  const key = (api as { api_key?: unknown }).api_key;
  return typeof key === "string" ? key.trim() : "";
}

export function readClaworksRequireApiKey(pluginConfig: Record<string, unknown> | null): boolean {
  const api = pluginConfig?.api;
  if (api && typeof api === "object" && !Array.isArray(api)) {
    if ((api as { require_api_key?: unknown }).require_api_key === true) {
      return true;
    }
  }
  const security = pluginConfig?.security;
  if (security && typeof security === "object" && !Array.isArray(security)) {
    return (security as { require_api_key?: unknown }).require_api_key === true;
  }
  return false;
}

/** Map gateway WebSocket URL to HTTP origin for same-host REST (/v1/health). */
export function gatewayUrlToHttpOrigin(gatewayUrl: string): string | null {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export async function probeClaworksHealth(params: {
  httpOrigin: string;
  apiKey?: string;
  gatewayToken?: string;
  fetchFn?: typeof fetch;
}): Promise<{
  httpStatus: number | null;
  payload: ClaworksHealthPayload | null;
  error: string | null;
}> {
  const fetchImpl = params.fetchFn ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = params.apiKey?.trim();
  const gatewayToken = params.gatewayToken?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (gatewayToken) {
    headers.Authorization = `Bearer ${gatewayToken}`;
  }

  try {
    const res = await fetchImpl(`${params.httpOrigin}/v1/health`, { headers });
    const text = await res.text();
    let payload: ClaworksHealthPayload | null = null;
    if (text) {
      try {
        payload = JSON.parse(text) as ClaworksHealthPayload;
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const code =
        payload && typeof payload === "object" && "code" in payload
          ? String((payload as { code?: unknown }).code)
          : "";
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : text.slice(0, 200);
      return {
        httpStatus: res.status,
        payload,
        error: code ? `${message} (${code})` : message || `HTTP ${res.status}`,
      };
    }
    return { httpStatus: res.status, payload, error: null };
  } catch (err) {
    return {
      httpStatus: null,
      payload: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function summarizeClaworksAttention(snapshot: ClaworksHealthSnapshot): {
  severity: "error" | "warning";
  title: string;
  description: string;
} | null {
  if (!snapshot.enabled) {
    return null;
  }
  if (snapshot.error) {
    return {
      severity: snapshot.httpStatus === 401 ? "warning" : "error",
      title: "ClaWorks unreachable",
      description: snapshot.error,
    };
  }
  if (snapshot.requireApiKey && !snapshot.hasApiKey) {
    return {
      severity: "warning",
      title: "ClaWorks API key missing",
      description: "Set plugins.entries.claworks-robot.config.api.api_key (pnpm claworks:init).",
    };
  }
  const status = snapshot.payload?.status;
  if (status === "unavailable") {
    return {
      severity: "error",
      title: "ClaWorks unhealthy",
      description: "Doctor reports unavailable — check packs and database.",
    };
  }
  if (status === "degraded") {
    return {
      severity: "warning",
      title: "ClaWorks degraded",
      description: "Some doctor checks warn — open Overview ClaWorks card for details.",
    };
  }
  return null;
}
