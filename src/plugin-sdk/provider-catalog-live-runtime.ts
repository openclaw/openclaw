import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";
import {
  buildSingleProviderApiKeyCatalog,
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "./ssrf-runtime.js";

export type LiveModelCatalogFetchGuard = typeof fetchWithSsrFGuard;

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
  policy?: SsrFPolicy;
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

// Live model catalogs are fetched at runtime from provider-controlled endpoints,
// so the success body is untrusted just like the error body. A faulty or hostile
// provider can stream an unbounded JSON document; reading it without a ceiling
// lets a single discovery call exhaust process memory. The cap is sized well
// above the largest known catalog (OpenRouter's live catalog is already >100KB
// and grows) while still bounding memory, matching the existing bounded reads
// for provider error bodies.
const LIVE_MODEL_CATALOG_BODY_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_MODEL_CATALOG_MAX_PAGES = 50;

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

export type OpenAICompatibleModelDiscoveryOptions = {
  /** Fixed endpoint used only while the effective inference base remains canonical. */
  endpointUrl?: {
    url: string;
    requireBaseUrl: string;
  };
  /** Relative path appended to the effective provider base URL. Defaults to `models`. */
  endpointPath?: string;
  /** Provider-specific response row selector when the response is not `{ data: [] }`. */
  readRows?: FetchLiveProviderModelRowsParams["readRows"];
  /** Provider-specific authorization headers for non-Bearer model-list APIs. */
  buildRequestHeaders?: FetchLiveProviderModelRowsParams["buildRequestHeaders"];
};

export type BuildOpenAICompatibleProviderCatalogParams = {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
  discovery?: OpenAICompatibleModelDiscoveryOptions;
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

function readLiveModelString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readLiveModelBoolean(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readLiveModelPositiveInteger(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function readLiveModelStringArray(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string[] {
  for (const record of records) {
    for (const key of keys) {
      const value = record?.[key];
      if (Array.isArray(value)) {
        const strings = value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
        if (strings.length > 0) {
          return strings;
        }
      }
    }
  }
  return [];
}

function isSafeLiveModelId(value: string): boolean {
  if (!value || value.length > 512) {
    return false;
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

const NON_TEXT_MODEL_ID_PATTERN =
  /(?:^|[\/_:.-])(?:embed(?:ding)?|rerank(?:er)?|whisper|transcri(?:be|ption)|tts|speech|moderation|guard|gpt-image|dall-e|flux|sdxl|stable-diffusion|imagen|image-gen(?:eration)?|text-to-image|veo|sora|video-gen(?:eration)?|text-to-video)(?:$|[\/_:.-])/i;

function rowAdvertisesNonTextModel(
  record: Record<string, unknown>,
  nestedRecords: readonly (Record<string, unknown> | undefined)[],
): boolean {
  const outputModalities = readLiveModelStringArray(
    [record, ...nestedRecords],
    ["output_modalities", "outputModalities", "output"],
  );
  if (outputModalities.length > 0 && !outputModalities.includes("text")) {
    return true;
  }
  const kind = readLiveModelString(record, [
    "type",
    "task",
    "model_type",
    "modelType",
    "pipeline_tag",
  ]);
  return Boolean(kind && NON_TEXT_MODEL_ID_PATTERN.test(kind));
}

function rowAdvertisesChatModel(
  record: Record<string, unknown>,
  nestedRecords: readonly (Record<string, unknown> | undefined)[],
): boolean {
  const capabilityStrings = readLiveModelStringArray(
    [record, ...nestedRecords],
    ["capabilities", "features", "endpoints", "supported_endpoints"],
  );
  if (capabilityStrings.some((value) => /chat|completion|response|generation/.test(value))) {
    return true;
  }
  return (
    readLiveModelBoolean(nestedRecords[0], [
      "completion_chat",
      "chat_completion",
      "chatCompletion",
    ]) === true
  );
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findLiveModelTemplate(
  modelId: string,
  models: readonly ModelDefinitionConfig[],
): ModelDefinitionConfig | undefined {
  const exact = models.find((model) => model.id === modelId);
  if (exact) {
    return exact;
  }
  const normalizedId = modelId.toLowerCase();
  let best: ModelDefinitionConfig | undefined;
  let bestScore = 0;
  for (const model of models) {
    const score = commonPrefixLength(normalizedId, model.id.toLowerCase());
    if (score > bestScore) {
      best = model;
      bestScore = score;
    }
  }
  return bestScore >= 4 ? best : undefined;
}

function inferLiveModelReasoning(modelId: string): boolean {
  return /(?:^|[\/_:.-])(?:reason(?:er|ing)?|thinking|deepseek-r1|o[134](?:-mini)?|gpt-5)(?:$|[\/_:.-])/i.test(
    modelId,
  );
}

function buildOpenAICompatibleLiveModel(
  row: unknown,
  fallback: ModelProviderConfig,
): ModelDefinitionConfig | undefined {
  const record = readLiveModelCatalogRecord(row);
  const id = readLiveModelString(record, ["id", "model", "model_name", "modelName"]);
  if (!record || !id || !isSafeLiveModelId(id)) {
    return undefined;
  }
  if (readLiveModelBoolean(record, ["active", "enabled", "available"]) === false) {
    return undefined;
  }
  const capabilities = readLiveModelCatalogRecord(record.capabilities);
  const architecture = readLiveModelCatalogRecord(record.architecture);
  const topProvider = readLiveModelCatalogRecord(record.top_provider);
  const modelInfo = readLiveModelCatalogRecord(record.model_info);
  const nestedRecords = [capabilities, architecture, topProvider, modelInfo];
  if (
    rowAdvertisesNonTextModel(record, nestedRecords) ||
    (!rowAdvertisesChatModel(record, nestedRecords) && NON_TEXT_MODEL_ID_PATTERN.test(id))
  ) {
    return undefined;
  }

  const exact = fallback.models.find((model) => model.id === id);
  if (exact) {
    return exact;
  }
  const template = findLiveModelTemplate(id, fallback.models);
  const inputModalities = readLiveModelStringArray(
    [record, architecture, capabilities, modelInfo],
    ["input_modalities", "inputModalities", "input"],
  );
  const contextWindow =
    readLiveModelPositiveInteger(
      [record, topProvider, capabilities, modelInfo],
      [
        "context_window",
        "contextWindow",
        "context_length",
        "contextLength",
        "context_size",
        "contextSize",
        "max_context_length",
        "maxModelLen",
        "max_model_len",
      ],
    ) ??
    fallback.contextWindow ??
    template?.contextWindow ??
    128_000;
  const maxTokens =
    readLiveModelPositiveInteger(
      [record, topProvider, capabilities, modelInfo],
      [
        "max_completion_tokens",
        "maxCompletionTokens",
        "max_output_tokens",
        "maxOutputTokens",
        "output_token_limit",
        "outputTokenLimit",
      ],
    ) ??
    fallback.maxTokens ??
    template?.maxTokens ??
    Math.min(contextWindow, 8192);
  const explicitReasoning = readLiveModelBoolean(record, [
    "reasoning",
    "supports_reasoning",
    "supportsReasoning",
    "thinking",
  ]);
  const featureNames = readLiveModelStringArray(
    [record, capabilities, modelInfo],
    ["features", "supported_parameters", "supportedParameters"],
  );
  const reasoning =
    explicitReasoning ??
    (featureNames.some((feature) => /reason|think/.test(feature)) ||
      template?.reasoning === true ||
      inferLiveModelReasoning(id));
  const input: ModelDefinitionConfig["input"] = inputModalities.includes("image")
    ? ["text", "image"]
    : (template?.input ?? ["text"]);

  return {
    id,
    name: readLiveModelString(record, ["display_name", "displayName", "name"]) ?? id,
    ...(template?.api ? { api: template.api } : {}),
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(template?.compat ? { compat: template.compat } : {}),
    ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
  };
}

function buildOpenAICompatibleLiveModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const models = rows
    .map((row) => buildOpenAICompatibleLiveModel(row, fallback))
    .filter((model): model is ModelDefinitionConfig => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
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

function buildHeaders(
  params: FetchLiveProviderModelIdsParams,
  safeReplayHeaders?: Headers,
): Headers {
  const headers = safeReplayHeaders
    ? new Headers(safeReplayHeaders)
    : new Headers(
        (params.buildRequestHeaders ?? buildDefaultLiveModelCatalogHeaders)({
          apiKey: normalizeLiveModelCatalogRequestApiKey(params.apiKey),
          discoveryApiKey: selectLiveModelCatalogRequestApiKey(params),
        }),
      );
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  return headers;
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function readLiveModelCatalogJson(response: Response, timeoutMs: number): Promise<unknown> {
  const buffer = await readResponseWithLimit(response, LIVE_MODEL_CATALOG_BODY_MAX_BYTES, {
    chunkTimeoutMs: timeoutMs,
    onOverflow: ({ size, maxBytes }) =>
      new Error(`Live model catalog response exceeded ${maxBytes} bytes (${size} bytes received)`),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Live model catalog response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return JSON.parse(new TextDecoder().decode(buffer));
}

function readLiveModelCatalogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLiveModelCatalogRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function readLiveModelCatalogNextUrl(body: unknown): string | undefined {
  const record = readLiveModelCatalogRecord(body);
  if (!record) {
    return undefined;
  }
  const links = readLiveModelCatalogRecord(record.links);
  return readLiveModelCatalogString(record.next) ?? readLiveModelCatalogString(links?.next);
}

function readLiveModelCatalogCursor(
  body: unknown,
): { name: "after" | "after_id" | "pageToken" | "page_token"; value: string } | undefined {
  const record = readLiveModelCatalogRecord(body);
  if (!record || record.has_more === false) {
    return undefined;
  }
  const nextCursor = readLiveModelCatalogString(record.next_cursor);
  if (nextCursor) {
    return { name: "after", value: nextCursor };
  }
  const lastId =
    readLiveModelCatalogString(record.last_id) ?? readLiveModelCatalogString(record.lastId);
  if (lastId) {
    return { name: "after_id", value: lastId };
  }
  const nextPageToken = readLiveModelCatalogString(record.nextPageToken);
  if (nextPageToken) {
    return { name: "pageToken", value: nextPageToken };
  }
  const nextPageTokenSnakeCase = readLiveModelCatalogString(record.next_page_token);
  return nextPageTokenSnakeCase ? { name: "page_token", value: nextPageTokenSnakeCase } : undefined;
}

type LiveModelCatalogNextPageResolution =
  | { status: "complete" }
  | { status: "incomplete" }
  | { status: "next"; url: string };

function bodyAdvertisesMoreLiveModelCatalogPages(body: unknown): boolean {
  const record = readLiveModelCatalogRecord(body);
  if (!record || record.has_more === false) {
    return false;
  }
  return Boolean(
    record.has_more === true ||
    readLiveModelCatalogNextUrl(body) ||
    readLiveModelCatalogString(record.next_cursor) ||
    readLiveModelCatalogString(record.nextPageToken) ||
    readLiveModelCatalogString(record.next_page_token),
  );
}

function tryParseUrl(url: string, base?: string): URL | undefined {
  try {
    return new URL(url, base);
  } catch {
    return undefined;
  }
}

function resolveLiveModelCatalogNextPage(
  currentUrl: string,
  body: unknown,
): LiveModelCatalogNextPageResolution {
  const rawNextUrl = readLiveModelCatalogNextUrl(body);
  if (rawNextUrl) {
    const currentParsed = tryParseUrl(currentUrl);
    const nextUrl = tryParseUrl(rawNextUrl, currentUrl);
    if (nextUrl && currentParsed && nextUrl.origin === currentParsed.origin) {
      return { status: "next", url: nextUrl.toString() };
    }
    // The provider advertised a next URL but it is malformed or cross-origin.
    // Attempt cursor-based pagination as a fallback before giving up.
    const cursor = readLiveModelCatalogCursor(body);
    if (cursor) {
      const cursorUrl = tryParseUrl(currentUrl);
      if (cursorUrl) {
        cursorUrl.searchParams.set(cursor.name, cursor.value);
        return { status: "next", url: cursorUrl.toString() };
      }
    }
    // No usable fallback: the provider explicitly advertised a next page we
    // cannot follow. Return incomplete so the caller surfaces a controlled
    // error instead of silently returning a truncated catalog.
    return { status: "incomplete" };
  }
  const cursor = readLiveModelCatalogCursor(body);
  if (cursor) {
    const nextUrl = tryParseUrl(currentUrl);
    if (nextUrl) {
      nextUrl.searchParams.set(cursor.name, cursor.value);
      return { status: "next", url: nextUrl.toString() };
    }
  }
  return bodyAdvertisesMoreLiveModelCatalogPages(body)
    ? { status: "incomplete" }
    : { status: "complete" };
}

async function fetchLiveProviderModelCatalogPage(
  params: FetchLiveProviderModelRowsParams & {
    fetchGuard: LiveModelCatalogFetchGuard;
    url: string;
    timeoutMs: number;
    safeReplayHeaders?: Headers;
  },
): Promise<{ body: unknown; finalUrl: string; requestHeaders: Headers; rows: readonly unknown[] }> {
  const requestHeaders = buildHeaders(params, params.safeReplayHeaders);
  const { response, finalUrl, release } = await params.fetchGuard({
    url: params.url,
    init: {
      headers: requestHeaders,
    },
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    policy: params.policy ?? ssrfPolicyFromHttpBaseUrlAllowedHostname(params.endpoint),
    ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
    ...(params.requireHttps !== undefined ? { requireHttps: params.requireHttps } : {}),
    auditContext: params.auditContext ?? `${params.providerId}-model-discovery`,
  });
  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new LiveModelCatalogHttpError(params.providerId, response.status);
    }
    const body = await readLiveModelCatalogJson(response, params.timeoutMs);
    return {
      body,
      finalUrl,
      requestHeaders,
      rows: (params.readRows ?? readDefaultLiveModelCatalogRows)(body),
    };
  } finally {
    await release();
  }
}

export async function fetchLiveProviderModelRows(
  params: FetchLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  const fetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
  const timeoutMs = params.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  const rows: unknown[] = [];
  const seenPageUrls = new Set<string>();
  let pageUrl: string | undefined = params.endpoint;
  let safeReplayHeaders: Headers | undefined;
  for (let page = 0; page < LIVE_MODEL_CATALOG_MAX_PAGES && pageUrl; page += 1) {
    if (seenPageUrls.has(pageUrl)) {
      break;
    }
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) {
      throw new Error(
        `${params.providerId} model discovery exceeded ${timeoutMs}ms before the catalog completed`,
      );
    }
    seenPageUrls.add(pageUrl);
    const requestedPageUrl = pageUrl;
    const result = await fetchLiveProviderModelCatalogPage({
      ...params,
      fetchGuard,
      url: requestedPageUrl,
      timeoutMs: remainingTimeoutMs,
      safeReplayHeaders,
    });
    rows.push(...result.rows);
    const finalParsed = tryParseUrl(result.finalUrl);
    const requestedParsed = tryParseUrl(requestedPageUrl);
    if (
      safeReplayHeaders ||
      !finalParsed ||
      !requestedParsed ||
      finalParsed.origin !== requestedParsed.origin
    ) {
      safeReplayHeaders = new Headers(
        retainSafeHeadersForCrossOriginRedirect(result.requestHeaders),
      );
    }
    const nextPage = resolveLiveModelCatalogNextPage(result.finalUrl, result.body);
    if (nextPage.status === "incomplete") {
      throw new Error(
        `${params.providerId} model discovery did not include a supported next page before the catalog completed`,
      );
    }
    pageUrl = nextPage.status === "next" ? nextPage.url : undefined;
  }
  if (pageUrl) {
    throw new Error(
      `${params.providerId} model discovery exceeded ${LIVE_MODEL_CATALOG_MAX_PAGES} pages before the catalog completed`,
    );
  }
  return rows;
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

function resolveLiveModelDiscoveryEndpoint(baseUrl: string, endpointPath: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = endpointPath.trim().replace(/^\/+/, "");
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function resolveFixedLiveModelDiscoveryEndpoint(
  baseUrl: string,
  endpoint: NonNullable<OpenAICompatibleModelDiscoveryOptions["endpointUrl"]>,
): string | undefined {
  const effectiveBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const requiredBaseUrl = endpoint.requireBaseUrl.trim().replace(/\/+$/, "");
  return effectiveBaseUrl === requiredBaseUrl ? endpoint.url : undefined;
}

export async function buildOpenAICompatibleLiveModelProviderConfig(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
  apiKey?: string;
  discoveryApiKey?: string;
  discovery?: OpenAICompatibleModelDiscoveryOptions;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const fallback = {
    ...params.providerConfig,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };
  const endpoint = params.discovery?.endpointUrl
    ? resolveFixedLiveModelDiscoveryEndpoint(fallback.baseUrl, params.discovery.endpointUrl)
    : resolveLiveModelDiscoveryEndpoint(
        fallback.baseUrl,
        params.discovery?.endpointPath ?? "models",
      );
  if (!endpoint) {
    return fallback;
  }
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: params.providerId,
      endpoint,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: 60_000,
      auditContext: `${params.providerId}-model-discovery`,
      readRows: params.discovery?.readRows,
      buildRequestHeaders: params.discovery?.buildRequestHeaders,
      shouldCacheRows: (modelRows) =>
        buildOpenAICompatibleLiveModels(modelRows, fallback).length > 0,
    });
    const models = buildOpenAICompatibleLiveModels(rows, fallback);
    if (models.length > 0) {
      return { ...fallback, models };
    }
  } catch {
    // Provider catalogs are advisory. Preserve the provider-owned seed when
    // credentials, networking, or a vendor response prevents live discovery.
  }
  return fallback;
}

export async function buildOpenAICompatibleProviderCatalog(
  params: BuildOpenAICompatibleProviderCatalogParams,
): Promise<ProviderCatalogResult> {
  const result = await buildSingleProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: params.providerId,
    buildProvider: params.buildProvider,
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
  });
  if (!result?.provider) {
    return result;
  }
  const auth = params.ctx.resolveProviderApiKey(params.providerId);
  return {
    provider: await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: params.providerId,
      providerConfig: result.provider,
      apiKey: auth.apiKey,
      discoveryApiKey: auth.discoveryApiKey,
      discovery: params.discovery,
    }),
  };
}
