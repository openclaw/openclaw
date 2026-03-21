// Public web-search registration helpers for provider plugins.

import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import { wrapWebContent } from "../security/external-content.js";
export { readNumberParam, readStringArrayParam, readStringParam } from "../agents/tools/common.js";
export { resolveCitationRedirectUrl } from "../agents/tools/web-search-citation-redirect.js";
export {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  FRESHNESS_TO_RECENCY,
  isoToPerplexityDate,
  MAX_SEARCH_COUNT,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  postTrustedWebToolsJson,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "../agents/tools/web-search-provider-common.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
export { resolveWebSearchProviderCredential } from "../agents/tools/web-search-provider-credentials.js";
export { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
export {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "../agents/tools/web-shared.js";
export { enablePluginInConfig } from "../plugins/enable.js";
export { formatCliCommand } from "../cli/command-format.js";
export { wrapWebContent } from "../security/external-content.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};

const DEFAULT_BRIGHTDATA_BASE_URL = "https://api.brightdata.com";
const ENSURED_BRIGHTDATA_ZONES = new Map<string, Promise<boolean>>();

export type BrightDataZoneKind = "browser" | "unlocker";

type TrustedWebToolsEndpointRunner = <T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init?: RequestInit;
  },
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
) => Promise<T>;

function resolveBrightDataApiEndpoint(baseUrl: string, pathname: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed || DEFAULT_BRIGHTDATA_BASE_URL);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return new URL(pathname, DEFAULT_BRIGHTDATA_BASE_URL).toString();
  }
}

function buildBrightDataZoneCacheKey(params: {
  apiToken: string;
  baseUrl: string;
  zoneName: string;
  kind: BrightDataZoneKind;
}): string {
  return [
    "brightdata-zone",
    params.apiToken.trim(),
    params.baseUrl.trim(),
    params.zoneName.trim(),
    params.kind,
  ].join(":");
}

function hasBrightDataZone(payload: unknown, zoneName: string): boolean {
  const records = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Array.isArray((payload as Record<string, unknown>).zones)
      ? ((payload as Record<string, unknown>).zones as unknown[])
      : [];
  return records.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).name === "string" &&
      ((entry as Record<string, unknown>).name as string).trim() === zoneName,
  );
}

function buildBrightDataZoneCreatePayload(params: {
  kind: BrightDataZoneKind;
  zoneName: string;
}): Record<string, unknown> {
  if (params.kind === "browser") {
    return {
      zone: { name: params.zoneName, type: "browser_api" },
      plan: { type: "browser_api" },
    };
  }
  return {
    zone: { name: params.zoneName, type: "unblocker" },
    plan: { type: "unblocker", ub_premium: true },
  };
}

async function requestBrightDataZoneJson(params: {
  requestEndpoint: TrustedWebToolsEndpointRunner;
  apiToken: string;
  baseUrl: string;
  pathname: string;
  timeoutSeconds: number;
  errorLabel: string;
  body?: unknown;
}): Promise<unknown> {
  const endpoint = resolveBrightDataApiEndpoint(params.baseUrl, params.pathname);
  return await params.requestEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: params.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${params.apiToken}`,
          Accept: "application/json",
          ...(params.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
      },
    },
    async ({ response }) => {
      const text = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(
          `${params.errorLabel} failed (${response.status}): ${wrapWebContent(text || response.statusText, "web_fetch")}`,
        );
      }
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`${params.errorLabel} returned invalid JSON.`);
      }
    },
  );
}

/**
 * Shared Bright Data zone bootstrap cache for both core web_fetch fallbacks and
 * Bright Data plugin flows.
 */
export async function ensureBrightDataZoneExists(params: {
  requestEndpoint: TrustedWebToolsEndpointRunner;
  apiToken: string;
  baseUrl: string;
  zoneName: string;
  kind: BrightDataZoneKind;
  timeoutSeconds: number;
  onError?: (error: unknown) => void;
}): Promise<boolean> {
  const cacheKey = buildBrightDataZoneCacheKey(params);
  const existing = ENSURED_BRIGHTDATA_ZONES.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const ensurePromise = (async () => {
    try {
      const activeZones = await requestBrightDataZoneJson({
        requestEndpoint: params.requestEndpoint,
        apiToken: params.apiToken,
        baseUrl: params.baseUrl,
        pathname: "/zone/get_active_zones",
        timeoutSeconds: params.timeoutSeconds,
        errorLabel: "Bright Data active zones",
      });
      if (hasBrightDataZone(activeZones, params.zoneName)) {
        return true;
      }
      await requestBrightDataZoneJson({
        requestEndpoint: params.requestEndpoint,
        apiToken: params.apiToken,
        baseUrl: params.baseUrl,
        pathname: "/zone",
        timeoutSeconds: params.timeoutSeconds,
        errorLabel: `Bright Data create ${params.kind} zone (${params.zoneName})`,
        body: buildBrightDataZoneCreatePayload({
          kind: params.kind,
          zoneName: params.zoneName,
        }),
      });
      return true;
    } catch (error) {
      ENSURED_BRIGHTDATA_ZONES.delete(cacheKey);
      params.onError?.(error);
      return false;
    }
  })();
  ENSURED_BRIGHTDATA_ZONES.set(cacheKey, ensurePromise);
  return await ensurePromise;
}

export function resetEnsuredBrightDataZones(): void {
  ENSURED_BRIGHTDATA_ZONES.clear();
}

/**
 * @deprecated Implement provider-owned `createTool(...)` directly on the
 * returned WebSearchProviderPlugin instead of routing through core.
 */
export function createPluginBackedWebSearchProvider(
  provider: WebSearchProviderPlugin,
): WebSearchProviderPlugin {
  return {
    ...provider,
    createTool: () => {
      throw new Error(
        `createPluginBackedWebSearchProvider(${provider.id}) is no longer supported. ` +
          "Define provider-owned createTool(...) directly in the extension's WebSearchProviderPlugin.",
      );
    },
  };
}
