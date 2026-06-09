/**
 * Shared web-search provider helpers.
 *
 * Handles provider config, credential normalization, endpoint calls, caching, and filters.
 */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Dispatcher } from "undici";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import type { FetchWithResponseReleaseResult } from "../../infra/net/egress-fetch.js";
import { normalizeHostname } from "../../infra/net/hostname.js";
import { shouldUseEnvHttpProxyForUrl } from "../../infra/net/proxy-env.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../../infra/net/redirect-headers.js";
import {
  fetchWithRuntimeDispatcherOrMockedGlobal,
  type DispatcherAwareRequestInit,
} from "../../infra/net/runtime-fetch.js";
import {
  closeDispatcher,
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist,
  SsrFBlockedError,
  type PinnedDispatcherPolicy,
} from "../../infra/net/ssrf.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "../../infra/net/undici-runtime.js";
import { resolveDebugProxySettings } from "../../proxy-capture/env.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";
import type { CacheEntry } from "./web-shared.js";

export type SearchConfigRecord = (NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : never
  : never) &
  Record<string, unknown>;

type UnsupportedWebSearchFilterName =
  | "country"
  | "language"
  | "freshness"
  | "date_after"
  | "date_before";

export const DEFAULT_SEARCH_COUNT = 5;
export const MAX_SEARCH_COUNT = 10;
export const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const WEB_TOOLS_ENDPOINT_MAX_REDIRECTS = 3;

type WebToolsEndpointCapture =
  | false
  | {
      flowId?: string;
      meta?: Record<string, unknown>;
    };

type WebToolsEndpointPolicy = {
  hostnameAllowlist?: string[];
  allowedHostnames?: string[];
  allowedOrigins?: string[];
};

type WebToolsEndpointBaseParams = {
  url: string;
  init?: RequestInit;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxRedirects?: number;
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  requireHttps?: boolean;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  retainAuthorizationRedirectHostnameAllowlist?: string[];
  capture?: WebToolsEndpointCapture;
  auditContext?: string;
};

type WebToolsNetworkGuardCompatParams = WebToolsEndpointBaseParams & {
  policy?: WebToolsEndpointPolicy;
  timeoutSeconds?: number;
};

type WebToolsEndpointParams = WebToolsEndpointBaseParams & {
  timeoutSeconds?: number;
};

export function resolveSearchTimeoutSeconds(searchConfig?: SearchConfigRecord): number {
  return resolveTimeoutSeconds(searchConfig?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
}

export function resolveSearchCacheTtlMs(searchConfig?: SearchConfigRecord): number {
  return resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
}

export function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

export function readConfiguredSecretString(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(normalizeResolvedSecretInputString({ value, path })) || undefined;
}

export function readProviderEnvValue(envVars: string[]): string | undefined {
  for (const envVar of envVars) {
    const value = normalizeSecretInput(process.env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveWebToolsEndpointTimeoutMs(params: WebToolsEndpointParams): number {
  if (
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
  ) {
    return Math.floor(params.timeoutMs);
  }
  return (
    finiteSecondsToTimerSafeMilliseconds(
      resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
      { floorSeconds: true },
    ) ?? DEFAULT_TIMEOUT_SECONDS * 1000
  );
}

function resolveWebToolsEndpointMaxRedirects(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : WEB_TOOLS_ENDPOINT_MAX_REDIRECTS;
}

function assertWebToolsEndpointUrl(params: { url: string; requireHttps?: boolean }) {
  if (!params.requireHttps) {
    return;
  }
  const parsed = new URL(params.url);
  if (parsed.protocol !== "https:") {
    throw new Error("Web tools endpoint requires an HTTPS URL");
  }
}

function createWebToolsEndpointDispatcher(
  dispatcherPolicy: PinnedDispatcherPolicy | undefined,
  timeoutMs: number,
): Dispatcher | undefined {
  if (!dispatcherPolicy) {
    return undefined;
  }
  if (dispatcherPolicy.mode === "direct") {
    return createHttp1Agent(
      dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : undefined,
      timeoutMs,
    );
  }
  if (dispatcherPolicy.mode === "env-proxy") {
    return createHttp1EnvHttpProxyAgent(
      {
        ...(dispatcherPolicy.connect
          ? {
              connect: { ...dispatcherPolicy.connect },
              requestTls: { ...dispatcherPolicy.connect },
            }
          : {}),
        ...(dispatcherPolicy.proxyTls ? { proxyTls: { ...dispatcherPolicy.proxyTls } } : {}),
      },
      timeoutMs,
    );
  }
  const proxyUrl = dispatcherPolicy.proxyUrl.trim();
  if (dispatcherPolicy.proxyTls) {
    return createHttp1ProxyAgent(
      { uri: proxyUrl, requestTls: { ...dispatcherPolicy.proxyTls } },
      timeoutMs,
    );
  }
  return createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
}

function resolveWebToolsEndpointDispatcherPolicy(
  params: Pick<WebToolsNetworkGuardCompatParams, "capture" | "dispatcherPolicy" | "url">,
): PinnedDispatcherPolicy | undefined {
  if (params.dispatcherPolicy) {
    return params.dispatcherPolicy;
  }
  if (shouldUseEnvHttpProxyForUrl(params.url)) {
    return { mode: "env-proxy" };
  }
  return params.capture === false ? { mode: "direct" } : undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function dropBodyHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("content-encoding");
  nextHeaders.delete("content-language");
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-location");
  nextHeaders.delete("content-type");
  nextHeaders.delete("transfer-encoding");
  return nextHeaders;
}

function rewriteRedirectInitForMethod(params: {
  init?: RequestInit;
  status: number;
}): RequestInit | undefined {
  const { init, status } = params;
  if (!init) {
    return init;
  }
  const currentMethod = init.method?.toUpperCase() ?? "GET";
  const shouldForceGet =
    status === 303
      ? currentMethod !== "GET" && currentMethod !== "HEAD"
      : (status === 301 || status === 302) && currentMethod === "POST";
  if (!shouldForceGet) {
    return init;
  }
  return {
    ...init,
    method: "GET",
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}

function rewriteRedirectInitForCrossOrigin(params: {
  init?: RequestInit;
  allowUnsafeReplay: boolean;
}): RequestInit | undefined {
  const { init, allowUnsafeReplay } = params;
  if (!init) {
    return init;
  }
  const safeHeaders = retainSafeHeadersForCrossOriginRedirect(init.headers);
  const currentMethod = init.method?.toUpperCase() ?? "GET";
  if (allowUnsafeReplay || currentMethod === "GET" || currentMethod === "HEAD") {
    return { ...init, headers: safeHeaders };
  }
  return {
    ...init,
    body: undefined,
    headers: dropBodyHeaders(safeHeaders),
  };
}

function resolveRetainedAuthorizationForRedirect(params: {
  init?: RequestInit;
  nextUrl: URL;
  hostnameAllowlist?: string[];
}): string | undefined {
  if (!params.init?.headers || !params.hostnameAllowlist?.length) {
    return undefined;
  }
  if (params.nextUrl.protocol !== "https:") {
    return undefined;
  }
  const allowlist = normalizeHostnameAllowlist(params.hostnameAllowlist);
  if (!allowlist.includes("*") && !matchesHostnameAllowlist(params.nextUrl.hostname, allowlist)) {
    return undefined;
  }
  return new Headers(params.init.headers).get("authorization") ?? undefined;
}

function restoreRedirectAuthorization(params: {
  init?: RequestInit;
  authorization?: string;
}): RequestInit | undefined {
  if (!params.authorization) {
    return params.init;
  }
  const headers = new Headers(params.init?.headers);
  headers.set("Authorization", params.authorization);
  return { ...params.init, headers };
}

function normalizeWebToolsPolicyOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function assertWebToolsEndpointPolicyShape(policy?: WebToolsEndpointPolicy): void {
  if (!policy) {
    return;
  }
  const supportedKeys = new Set(["hostnameAllowlist", "allowedHostnames", "allowedOrigins"]);
  for (const key of Object.keys(policy)) {
    if (!supportedKeys.has(key)) {
      throw new Error(
        `Web tools endpoint policy only supports hostname/origin allowlists; unsupported field: ${key}`,
      );
    }
  }
}

function assertWebToolsEndpointUrlAllowedByPolicy(
  url: string,
  policy?: WebToolsEndpointPolicy,
): void {
  assertWebToolsEndpointPolicyShape(policy);
  const hostnameAllowlist = normalizeHostnameAllowlist([
    ...(policy?.hostnameAllowlist ?? []),
    ...(policy?.allowedHostnames ?? []),
  ]);
  const allowedOrigins = (policy?.allowedOrigins ?? [])
    .map((origin) => normalizeWebToolsPolicyOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
  if (hostnameAllowlist.length === 0 && allowedOrigins.length === 0) {
    return;
  }

  const parsed = new URL(url);
  const normalizedHostname = normalizeHostname(parsed.hostname);
  const origin = normalizeWebToolsPolicyOrigin(parsed.toString());
  const hostAllowed =
    hostnameAllowlist.length > 0 && matchesHostnameAllowlist(normalizedHostname, hostnameAllowlist);
  const originAllowed = origin ? allowedOrigins.includes(origin) : false;
  if (!hostAllowed && !originAllowed) {
    throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${parsed.hostname}`);
  }
}

async function captureWebToolsEndpointExchange(params: {
  url: string;
  init?: RequestInit;
  response: Response;
  capture?: WebToolsEndpointCapture;
  auditContext?: string;
  capturedByGlobalFetchPatch: boolean;
}): Promise<void> {
  if (params.capture === false) {
    return;
  }
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const { captureHttpExchange, isDebugProxyGlobalFetchPatchInstalled } =
    await import("../../proxy-capture/runtime.js");
  if (params.capturedByGlobalFetchPatch && isDebugProxyGlobalFetchPatchInstalled()) {
    return;
  }
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
      flowId: params.capture?.flowId,
      meta: {
        captureOrigin: "web-tools-endpoint",
        ...(params.auditContext ? { auditContext: params.auditContext } : {}),
        ...params.capture?.meta,
      },
    },
    settings,
  );
}

async function fetchWebToolsEndpointResponse(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxRedirects?: number;
  requireHttps?: boolean;
  dispatcher?: Dispatcher;
  policy?: WebToolsEndpointPolicy;
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  retainAuthorizationRedirectHostnameAllowlist?: string[];
  capture?: WebToolsEndpointCapture;
  auditContext?: string;
}): Promise<{ response: Response; finalUrl: string }> {
  assertWebToolsEndpointUrl(params);
  assertWebToolsEndpointUrlAllowedByPolicy(params.url, params.policy);
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxRedirects = resolveWebToolsEndpointMaxRedirects(params.maxRedirects);
  let currentUrl = params.url;
  let currentInit = params.init ? { ...params.init } : undefined;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const init: DispatcherAwareRequestInit = {
      ...(currentInit ? { ...currentInit } : {}),
      redirect: "manual",
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.dispatcher ? { dispatcher: params.dispatcher } : {}),
    };
    const useRuntimeFetch = Boolean(params.dispatcher && fetchImpl === fetch);
    const response = useRuntimeFetch
      ? await fetchWithRuntimeDispatcherOrMockedGlobal(currentUrl, init)
      : await fetchImpl(currentUrl, init);
    await captureWebToolsEndpointExchange({
      url: currentUrl,
      init,
      response,
      capture: params.capture,
      auditContext: params.auditContext,
      capturedByGlobalFetchPatch: !useRuntimeFetch && fetchImpl === globalThis.fetch,
    });
    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: response.url || currentUrl };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new Error(`Web tools endpoint redirect missing location header (${response.status})`);
    }
    if (redirectCount + 1 > maxRedirects) {
      throw new Error(`Web tools endpoint exceeded redirect limit (${maxRedirects})`);
    }
    const currentParsedUrl = new URL(currentUrl);
    const nextParsedUrl = new URL(location, currentParsedUrl);
    if (params.requireHttps && nextParsedUrl.protocol !== "https:") {
      throw new Error("Web tools endpoint requires an HTTPS URL");
    }
    assertWebToolsEndpointUrlAllowedByPolicy(nextParsedUrl.toString(), params.policy);
    const retainedAuthorization = resolveRetainedAuthorizationForRedirect({
      init: currentInit,
      nextUrl: nextParsedUrl,
      hostnameAllowlist: params.retainAuthorizationRedirectHostnameAllowlist,
    });
    currentInit = rewriteRedirectInitForMethod({
      init: currentInit,
      status: response.status,
    });
    if (nextParsedUrl.origin !== currentParsedUrl.origin) {
      currentInit = rewriteRedirectInitForCrossOrigin({
        init: currentInit,
        allowUnsafeReplay: params.allowCrossOriginUnsafeRedirectReplay === true,
      });
      currentInit = restoreRedirectAuthorization({
        init: currentInit,
        authorization: retainedAuthorization,
      });
    }
    currentUrl = nextParsedUrl.toString();
  }
}

export async function withWebToolsEndpoint<T>(
  params: WebToolsEndpointParams,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  void params.allowCrossOriginUnsafeRedirectReplay;
  void params.auditContext;
  void params.retainAuthorizationRedirectHostnameAllowlist;
  const timeoutMs = resolveWebToolsEndpointTimeoutMs(params);
  const timeout = buildTimeoutAbortSignal({
    timeoutMs,
    signal: params.signal,
    operation: "web-tools-endpoint",
    url: params.url,
  });
  let response: Response | undefined;
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = createWebToolsEndpointDispatcher(
      resolveWebToolsEndpointDispatcherPolicy(params),
      timeoutMs,
    );
    const result = await fetchWebToolsEndpointResponse({
      url: params.url,
      init: params.init,
      signal: timeout.signal,
      fetchImpl: params.fetchImpl,
      maxRedirects: params.maxRedirects,
      requireHttps: params.requireHttps,
      dispatcher,
      allowCrossOriginUnsafeRedirectReplay: params.allowCrossOriginUnsafeRedirectReplay,
      retainAuthorizationRedirectHostnameAllowlist:
        params.retainAuthorizationRedirectHostnameAllowlist,
      capture: params.capture,
      auditContext: params.auditContext,
    });
    response = result.response;
    return await run({ response, finalUrl: result.finalUrl });
  } finally {
    timeout.cleanup();
    await closeDispatcher(dispatcher);
    await response?.body?.cancel().catch(() => undefined);
  }
}

function assertNoUnsupportedWebToolsNetworkGuardOptions(params: Record<string, unknown>): void {
  const unsupportedFields = [
    "lookupFn",
    "pinDns",
    "useEnvProxy",
    "mode",
    "proxy",
    "dangerouslyAllowEnvProxyWithoutPinnedDns",
  ];
  for (const field of unsupportedFields) {
    if (field in params && params[field] !== undefined) {
      throw new Error(
        `fetchWithWebToolsNetworkGuard no longer supports ${field}; use proxy.enabled plus external proxy policy`,
      );
    }
  }
  assertWebToolsEndpointPolicyShape(params.policy as WebToolsEndpointPolicy | undefined);
}

/**
 * @deprecated Compatibility export for older plugins. Network egress policy is
 * now owned by `proxy.enabled` plus the operator's external proxy policy.
 */
export async function fetchWithWebToolsNetworkGuard(
  params: WebToolsNetworkGuardCompatParams,
): Promise<FetchWithResponseReleaseResult> {
  assertNoUnsupportedWebToolsNetworkGuardOptions(params as Record<string, unknown>);
  const timeoutMs = resolveWebToolsEndpointTimeoutMs(params);
  const timeout = buildTimeoutAbortSignal({
    timeoutMs,
    signal: params.signal,
    operation: "web-tools-endpoint",
    url: params.url,
  });
  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response | undefined;
  let dispatcher: Dispatcher | undefined;
  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    timeout.cleanup();
    await closeDispatcher(dispatcher);
    await response?.body?.cancel().catch(() => undefined);
  };
  try {
    dispatcher = createWebToolsEndpointDispatcher(
      resolveWebToolsEndpointDispatcherPolicy(params),
      timeoutMs,
    );
    const result = await fetchWebToolsEndpointResponse({
      url: params.url,
      init: params.init,
      signal: timeout.signal,
      fetchImpl,
      maxRedirects: params.maxRedirects,
      requireHttps: params.requireHttps,
      dispatcher,
      policy: params.policy,
      allowCrossOriginUnsafeRedirectReplay: params.allowCrossOriginUnsafeRedirectReplay,
      retainAuthorizationRedirectHostnameAllowlist:
        params.retainAuthorizationRedirectHostnameAllowlist,
      capture: params.capture,
      auditContext: params.auditContext,
    });
    response = result.response;
    return {
      response,
      finalUrl: result.finalUrl,
      release,
      refreshTimeout: timeout.refresh,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export const withStrictWebToolsEndpoint = withWebToolsEndpoint;

export async function withTrustedWebToolsEndpoint<T>(
  params: WebToolsEndpointParams,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return withWebToolsEndpoint(params, run);
}

export async function withSelfHostedWebToolsEndpoint<T>(
  params: WebToolsEndpointParams,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return withWebToolsEndpoint(params, run);
}

export async function withTrustedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  return withWebToolsEndpoint(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
    },
    async ({ response }) => run(response),
  );
}

export async function withSelfHostedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  return withWebToolsEndpoint(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
    },
    async ({ response }) => run(response),
  );
}

export async function postTrustedWebToolsJson<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    apiKey: string;
    body: Record<string, unknown>;
    errorLabel: string;
    maxErrorBytes?: number;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
  },
  parseResponse: (response: Response) => Promise<T>,
): Promise<T> {
  return withWebToolsEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: {
          ...params.extraHeaders,
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, {
          maxBytes: params.maxErrorBytes ?? 64_000,
        });
        throw new Error(
          `${params.errorLabel} API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      return await parseResponse(response);
    },
  );
}

export async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

export function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);

export type WebSearchFreshnessProvider = "brave" | "perplexity";
export type WebSearchRecencyFreshness = "day" | "week" | "month" | "year";
export type ParsedWebSearchFreshness<Provider extends WebSearchFreshnessProvider> =
  Provider extends "perplexity" ? WebSearchRecencyFreshness : string;

export const FRESHNESS_TO_RECENCY: Record<string, string> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};
const RECENCY_TO_FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isoToPerplexityDate(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}/${year}`;
}

/** Accepts ISO dates plus Perplexity `M/D/YYYY` dates and returns canonical ISO dates. */
export function normalizeToIsoDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return isValidIsoDate(trimmed) ? trimmed : undefined;
  }
  const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
  if (match) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

/** Parses optional date range filters and returns provider-facing validation errors. */
export function parseIsoDateRange(params: {
  rawDateAfter?: string;
  rawDateBefore?: string;
  invalidDateAfterMessage: string;
  invalidDateBeforeMessage: string;
  invalidDateRangeMessage: string;
  docs?: string;
}):
  | { dateAfter?: string; dateBefore?: string }
  | {
      error: "invalid_date" | "invalid_date_range";
      message: string;
      docs: string;
    } {
  const docs = params.docs ?? "https://docs.openclaw.ai/tools/web";
  const dateAfter = params.rawDateAfter ? normalizeToIsoDate(params.rawDateAfter) : undefined;
  if (params.rawDateAfter && !dateAfter) {
    return {
      error: "invalid_date",
      message: params.invalidDateAfterMessage,
      docs,
    };
  }

  const dateBefore = params.rawDateBefore ? normalizeToIsoDate(params.rawDateBefore) : undefined;
  if (params.rawDateBefore && !dateBefore) {
    return {
      error: "invalid_date",
      message: params.invalidDateBeforeMessage,
      docs,
    };
  }

  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return {
      error: "invalid_date_range",
      message: params.invalidDateRangeMessage,
      docs,
    };
  }

  return { dateAfter, dateBefore };
}

/** Converts shared freshness names into provider-specific Brave or Perplexity values. */
export function normalizeFreshness(
  value: string | undefined,
  provider: WebSearchFreshnessProvider,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
  }
  if (PERPLEXITY_RECENCY_VALUES.has(lower)) {
    return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
  }
  if (provider === "brave") {
    const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
    if (match) {
      const [, start, end] = match;
      // Brave accepts explicit ISO ranges; Perplexity only supports recency buckets here.
      if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) {
        return `${start}to${end}`;
      }
    }
  }

  return undefined;
}

/** Parses freshness/date filters while rejecting combinations providers cannot express safely. */
export function parseWebSearchTimeFilters<Provider extends WebSearchFreshnessProvider>(params: {
  rawFreshness?: string;
  rawDateAfter?: string;
  rawDateBefore?: string;
  freshnessProvider: Provider;
  invalidFreshnessMessage: string;
  invalidDateAfterMessage: string;
  invalidDateBeforeMessage: string;
  invalidDateRangeMessage: string;
  conflictingTimeFiltersMessage?: string;
  docs?: string;
}):
  | {
      freshness?: ParsedWebSearchFreshness<Provider>;
      dateAfter?: string;
      dateBefore?: string;
    }
  | {
      error:
        | "invalid_freshness"
        | "invalid_date"
        | "invalid_date_range"
        | "conflicting_time_filters";
      message: string;
      docs: string;
    } {
  const docs = params.docs ?? "https://docs.openclaw.ai/tools/web";
  const freshness = params.rawFreshness
    ? normalizeFreshness(params.rawFreshness, params.freshnessProvider)
    : undefined;
  if (params.rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: params.invalidFreshnessMessage,
      docs,
    };
  }

  if (params.rawFreshness && (params.rawDateAfter || params.rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        params.conflictingTimeFiltersMessage ??
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs,
    };
  }

  const parsedDateRange = parseIsoDateRange({
    rawDateAfter: params.rawDateAfter,
    rawDateBefore: params.rawDateBefore,
    invalidDateAfterMessage: params.invalidDateAfterMessage,
    invalidDateBeforeMessage: params.invalidDateBeforeMessage,
    invalidDateRangeMessage: params.invalidDateRangeMessage,
    docs,
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }

  return freshness
    ? {
        freshness: freshness as ParsedWebSearchFreshness<Provider>,
        ...parsedDateRange,
      }
    : parsedDateRange;
}

/** Reads a search cache payload and marks it so provider responses can disclose cache hits. */
export function readCachedSearchPayload(cacheKey: string): Record<string, unknown> | undefined {
  const cached = readCache(SEARCH_CACHE, cacheKey);
  return cached ? { ...cached.value, cached: true } : undefined;
}

/** Builds a normalized cache key from provider-specific search dimensions. */
export function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string {
  return normalizeCacheKey(
    parts.map((part) => (part === undefined ? "default" : String(part))).join(":"),
  );
}

/** Stores one provider search payload with its provider-selected TTL. */
export function writeCachedSearchPayload(
  cacheKey: string,
  payload: Record<string, unknown>,
  ttlMs: number,
): void {
  writeCache(SEARCH_CACHE, cacheKey, payload, ttlMs);
}

function readUnsupportedSearchFilter(
  params: Record<string, unknown>,
): UnsupportedWebSearchFilterName | undefined {
  for (const name of ["country", "language", "freshness", "date_after", "date_before"] as const) {
    const value = params[name];
    if (typeof value === "string" && value.trim()) {
      return name;
    }
  }

  return undefined;
}

function describeUnsupportedSearchFilter(name: UnsupportedWebSearchFilterName): string {
  switch (name) {
    case "country":
      return "country filtering";
    case "language":
      return "language filtering";
    case "freshness":
      return "freshness filtering";
    case "date_after":
    case "date_before":
      return "date_after/date_before filtering";
  }
  throw new Error("Unsupported web search filter");
}

export function buildUnsupportedSearchFilterResponse(
  params: Record<string, unknown>,
  provider: string,
  docs = "https://docs.openclaw.ai/tools/web",
):
  | {
      error: string;
      message: string;
      docs: string;
    }
  | undefined {
  const unsupported = readUnsupportedSearchFilter(params);
  if (!unsupported) {
    return undefined;
  }

  const label = describeUnsupportedSearchFilter(unsupported);
  const supportedLabel =
    unsupported === "date_after" || unsupported === "date_before" ? "date filtering" : label;

  return {
    error: unsupported.startsWith("date_")
      ? "unsupported_date_filter"
      : `unsupported_${unsupported}`,
    message: `${label} is not supported by the ${provider} provider. Only Brave and Perplexity support ${supportedLabel}.`,
    docs,
  };
}
