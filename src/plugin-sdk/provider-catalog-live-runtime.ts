import type { Dispatcher } from "undici";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { getActiveManagedProxyLoopbackMode } from "../infra/net/proxy/active-proxy-state.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import {
  fetchWithRuntimeDispatcherOrMockedGlobal,
  type DispatcherAwareRequestInit,
} from "../infra/net/runtime-fetch.js";
import { closeDispatcher, createPinnedLookup, type LookupFn } from "../infra/net/ssrf.js";
import { createHttp1Agent } from "../infra/net/undici-runtime.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";

export type LiveModelCatalogFetchGuard = (params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  lookupFn?: LookupFn;
  requireHttps?: boolean;
  auditContext?: string;
}) => Promise<{ response: Response; release: () => Promise<void> }>;

export type LiveModelCatalogHeaderContext = {
  apiKey?: string;
  discoveryApiKey?: string;
};

export { clearLiveCatalogCacheForTests };

export type FetchLiveProviderModelIdsParams = {
  providerId: string;
  endpoint: string;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditContext?: string;
  lookupFn?: LookupFn;
  requireHttps?: boolean;
  readRows?: (body: unknown) => readonly unknown[];
  readModelId?: (row: unknown) => string | undefined;
  buildRequestHeaders?: (ctx: LiveModelCatalogHeaderContext) => HeadersInit;
};

export type FetchLiveProviderModelRowsParams = Omit<FetchLiveProviderModelIdsParams, "readModelId">;

export type CachedLiveProviderModelRowsParams = FetchLiveProviderModelRowsParams & {
  ttlMs?: number;
  cacheKeyParts?: readonly unknown[];
  shouldCacheRows?: (rows: readonly unknown[]) => boolean;
};

export class LiveModelCatalogHttpError extends Error {
  readonly status: number;

  constructor(providerId: string, status: number) {
    super(`${providerId} model discovery failed: HTTP ${status}`);
    this.name = "LiveModelCatalogHttpError";
    this.status = status;
  }
}

export type BuildLiveModelProviderConfigParams<T extends ModelDefinitionConfig> =
  FetchLiveProviderModelIdsParams & {
    providerConfig: Omit<ModelProviderConfig, "models">;
    models: readonly T[];
    ttlMs?: number;
    cacheKeyParts?: readonly unknown[];
  };

function readDefaultLiveModelCatalogRows(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  throw new Error("Live model catalog response must be an array or { data: [] }");
}

function readDefaultLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim();
  return modelId || undefined;
}

function normalizeLiveModelCatalogRequestApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function selectLiveModelCatalogRequestApiKey(
  ctx: LiveModelCatalogHeaderContext,
): string | undefined {
  return (
    normalizeLiveModelCatalogRequestApiKey(ctx.discoveryApiKey) ??
    normalizeLiveModelCatalogRequestApiKey(ctx.apiKey)
  );
}

function buildDefaultLiveModelCatalogHeaders(ctx: LiveModelCatalogHeaderContext): HeadersInit {
  const requestApiKey = selectLiveModelCatalogRequestApiKey(ctx);
  return {
    Accept: "application/json",
    ...(requestApiKey ? { Authorization: `Bearer ${requestApiKey}` } : {}),
  };
}

function buildHeaders(params: FetchLiveProviderModelIdsParams): Headers {
  const requestApiKey = selectLiveModelCatalogRequestApiKey(params);
  const headers = new Headers(
    (params.buildRequestHeaders ?? buildDefaultLiveModelCatalogHeaders)({
      apiKey: normalizeLiveModelCatalogRequestApiKey(params.apiKey),
      discoveryApiKey: requestApiKey,
    }),
  );
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  return headers;
}

function isLiveCatalogRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type LiveCatalogLookupResult =
  | {
      address: string;
      family: number;
    }
  | Array<{
      address: string;
      family: number;
    }>;

function normalizeLiveCatalogOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function assertLiveCatalogEndpointAllowsUrl(providerId: string, url: URL, endpoint: string): void {
  const configuredOrigin = normalizeLiveCatalogOrigin(endpoint);
  const configuredHostname = configuredOrigin ? new URL(configuredOrigin).hostname : undefined;
  if (
    configuredHostname &&
    normalizeHostname(url.hostname) !== normalizeHostname(configuredHostname)
  ) {
    throw new Error(`${providerId} model discovery URL host is not allowed: ${url.hostname}`);
  }
}

async function captureLiveCatalogExchange(params: {
  url: string;
  init?: RequestInit;
  response: Response;
  providerId: string;
  auditContext?: string;
}): Promise<void> {
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const { captureHttpExchange } = await import("../proxy-capture/runtime.js");
  captureHttpExchange(
    {
      url: params.url,
      method: params.init?.method ?? "GET",
      requestHeaders: params.init?.headers as Headers | Record<string, string> | undefined,
      requestBody:
        (params.init as (RequestInit & { body?: BodyInit | Buffer | string | null }) | undefined)
          ?.body ?? null,
      response: params.response,
      transport: "http",
      meta: {
        captureOrigin: "live-model-catalog",
        provider: params.providerId,
        ...(params.auditContext ? { auditContext: params.auditContext } : {}),
      },
    },
    settings,
  );
}

function normalizeLiveCatalogLookupResults(results: LiveCatalogLookupResult): string[] {
  const entries = Array.isArray(results) ? results : [results];
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const entry of entries) {
    if (!entry.address || seen.has(entry.address)) {
      continue;
    }
    seen.add(entry.address);
    addresses.push(entry.address);
  }
  return addresses;
}

async function createLiveCatalogDispatcher(
  url: URL,
  lookupFn: LookupFn | undefined,
  timeoutMs: number | undefined,
): Promise<Dispatcher | undefined> {
  if (!lookupFn || getActiveManagedProxyLoopbackMode() !== undefined) {
    return undefined;
  }
  const hostname = normalizeHostname(url.hostname);
  const results = (await lookupFn(hostname, { all: true })) as LiveCatalogLookupResult;
  const addresses = normalizeLiveCatalogLookupResults(results);
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve hostname: ${url.hostname}`);
  }
  return createHttp1Agent(
    { connect: { lookup: createPinnedLookup({ hostname, addresses }) } },
    timeoutMs,
  );
}

async function fetchLiveCatalogResponse(params: {
  endpoint: string;
  headers: Headers;
  signal?: AbortSignal;
  providerId: string;
  requireHttps?: boolean;
  lookupFn?: LookupFn;
  timeoutMs?: number;
  auditContext?: string;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  let currentUrl = params.endpoint;
  let currentHeaders = params.headers;
  let finalResponse: Response | undefined;
  let finalDispatcher: Dispatcher | undefined;
  const release = async () => {
    await finalResponse?.body?.cancel().catch(() => undefined);
    await closeDispatcher(finalDispatcher);
  };
  for (let redirectCount = 0; ; redirectCount += 1) {
    const parsedUrl = new URL(currentUrl);
    assertLiveCatalogEndpointAllowsUrl(params.providerId, parsedUrl, params.endpoint);
    let dispatcher: Dispatcher | undefined;
    let response: Response;
    try {
      dispatcher = await createLiveCatalogDispatcher(parsedUrl, params.lookupFn, params.timeoutMs);
      const requestInit: DispatcherAwareRequestInit = {
        headers: currentHeaders,
        redirect: "manual",
        ...(params.signal ? { signal: params.signal } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      };
      response = await fetchWithRuntimeDispatcherOrMockedGlobal(currentUrl, requestInit);
      await captureLiveCatalogExchange({
        url: currentUrl,
        init: requestInit,
        response,
        providerId: params.providerId,
        auditContext: params.auditContext,
      });
    } catch (error) {
      await closeDispatcher(dispatcher);
      throw error;
    }
    if (!isLiveCatalogRedirectStatus(response.status)) {
      finalResponse = response;
      finalDispatcher = dispatcher;
      return { response, release };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    await closeDispatcher(dispatcher);
    if (!location) {
      throw new Error(`${params.providerId} model discovery redirect missing location header`);
    }
    if (redirectCount >= 3) {
      throw new Error(`${params.providerId} model discovery exceeded redirect limit`);
    }
    const nextUrl = new URL(location, currentUrl);
    if (params.requireHttps && nextUrl.protocol !== "https:") {
      throw new Error(`${params.providerId} model discovery requires an https endpoint`);
    }
    assertLiveCatalogEndpointAllowsUrl(params.providerId, nextUrl, params.endpoint);
    if (nextUrl.origin !== new URL(currentUrl).origin) {
      currentHeaders = new Headers(retainSafeHeadersForCrossOriginRedirect(currentHeaders));
    }
    currentUrl = nextUrl.toString();
  }
}

export async function fetchLiveProviderModelRows(
  params: FetchLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  if (params.requireHttps) {
    const parsed = new URL(params.endpoint);
    if (parsed.protocol !== "https:") {
      throw new Error(`${params.providerId} model discovery requires an https endpoint`);
    }
  }
  let response: Response | undefined;
  let release: () => Promise<void>;
  if (params.fetchGuard) {
    const guarded = await params.fetchGuard({
      url: params.endpoint,
      init: {
        headers: buildHeaders(params),
      },
      signal: params.signal,
      timeoutMs: params.timeoutMs ?? 5_000,
      ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
      ...(params.requireHttps !== undefined ? { requireHttps: params.requireHttps } : {}),
      auditContext: params.auditContext ?? `${params.providerId}-model-discovery`,
    });
    response = guarded.response;
    release = guarded.release;
  } else {
    const timeout = buildTimeoutAbortSignal({
      timeoutMs: params.timeoutMs ?? 5_000,
      signal: params.signal,
      operation: "live-model-catalog",
      url: params.endpoint,
    });
    release = async () => {
      timeout.cleanup();
      await response?.body?.cancel().catch(() => undefined);
    };
    try {
      const direct = await fetchLiveCatalogResponse({
        endpoint: params.endpoint,
        headers: buildHeaders(params),
        signal: timeout.signal,
        providerId: params.providerId,
        requireHttps: params.requireHttps,
        lookupFn: params.lookupFn,
        timeoutMs: params.timeoutMs ?? 5_000,
        auditContext: params.auditContext ?? `${params.providerId}-model-discovery`,
      });
      response = direct.response;
      release = async () => {
        timeout.cleanup();
        await direct.release();
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  try {
    if (!response) {
      throw new Error(`${params.providerId} model discovery returned no response`);
    }
    if (!response.ok) {
      throw new LiveModelCatalogHttpError(params.providerId, response.status);
    }
    return (params.readRows ?? readDefaultLiveModelCatalogRows)(await response.json());
  } finally {
    await release();
  }
}

function liveModelCatalogAuthCacheKey(params: LiveModelCatalogHeaderContext): string | undefined {
  return selectLiveModelCatalogRequestApiKey(params);
}

export async function getCachedLiveProviderModelRows(
  params: CachedLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  return await getCachedLiveCatalogValue({
    keyParts: params.cacheKeyParts ?? [
      params.providerId,
      "model-rows",
      params.endpoint,
      liveModelCatalogAuthCacheKey(params),
    ],
    ttlMs: params.ttlMs,
    load: async () => await fetchLiveProviderModelRows(params),
    shouldCache: params.shouldCacheRows,
  });
}

export async function fetchLiveProviderModelIds(
  params: FetchLiveProviderModelIdsParams,
): Promise<string[]> {
  const rows = await fetchLiveProviderModelRows(params);
  const readModelId = params.readModelId ?? readDefaultLiveModelId;
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const row of rows) {
    const modelId = readModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

function buildProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
  models: readonly T[],
): ModelProviderConfig {
  return {
    ...params.providerConfig,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: [...models],
  };
}

export async function buildLiveModelProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
): Promise<ModelProviderConfig> {
  try {
    const liveModelIds = await getCachedLiveCatalogValue({
      keyParts: params.cacheKeyParts ?? [
        params.providerId,
        "models",
        params.endpoint,
        liveModelCatalogAuthCacheKey(params),
      ],
      ttlMs: params.ttlMs,
      load: async () => await fetchLiveProviderModelIds(params),
      shouldCache: (modelIds) => modelIds.length > 0,
    });
    const liveModelIdSet = new Set(liveModelIds);
    const models = params.models.filter((model) => liveModelIdSet.has(model.id));
    if (models.length > 0) {
      return buildProviderConfig(params, models);
    }
  } catch {
    // Live model catalogs are advisory. Keep provider-owned static rows visible
    // when discovery is unavailable or the provider returns an unexpected body.
  }
  return buildProviderConfig(params, params.models);
}
