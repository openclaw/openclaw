import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SEARCH_PROVIDERS = ["brave"] as const;
const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_CACHE_TTL_MINUTES = 15;
const DEFAULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type WebSearchConfig = NonNullable<ClawdbotConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type WebFetchConfig = NonNullable<ClawdbotConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type FirecrawlFetchConfig =
  | {
      enabled?: boolean;
      apiKey?: string;
      baseUrl?: string;
      onlyMainContent?: boolean;
      maxAgeMs?: number;
      timeoutSeconds?: number;
    }
  | undefined;
type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  insertedAt: number;
};

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
});

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: 'Extraction mode ("markdown" or "text").',
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded).",
      minimum: 100,
    }),
  ),
});

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

function resolveSearchConfig(cfg?: ClawdbotConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") return undefined;
  return search as WebSearchConfig;
}

function resolveFetchConfig(cfg?: ClawdbotConfig): WebFetchConfig {
  const fetch = cfg?.tools?.web?.fetch;
  if (!fetch || typeof fetch !== "object") return undefined;
  return fetch as WebFetchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") return params.search.enabled;
  if (params.sandboxed) return true;
  return true;
}

function resolveFetchEnabled(params: { fetch?: WebFetchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled;
  return true;
}

function resolveFetchReadabilityEnabled(fetch?: WebFetchConfig): boolean {
  if (typeof fetch?.readability === "boolean") return fetch.readability;
  return true;
}

function resolveFirecrawlConfig(fetch?: WebFetchConfig): FirecrawlFetchConfig {
  if (!fetch || typeof fetch !== "object") return undefined;
  const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : undefined;
  if (!firecrawl || typeof firecrawl !== "object") return undefined;
  return firecrawl as FirecrawlFetchConfig;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string" ? search.apiKey.trim() : "";
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveFirecrawlApiKey(firecrawl?: FirecrawlFetchConfig): string | undefined {
  const fromConfig =
    firecrawl && "apiKey" in firecrawl && typeof firecrawl.apiKey === "string"
      ? firecrawl.apiKey.trim()
      : "";
  const fromEnv = (process.env.FIRECRAWL_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveFirecrawlEnabled(params: {
  firecrawl?: FirecrawlFetchConfig;
  apiKey?: string;
}): boolean {
  if (typeof params.firecrawl?.enabled === "boolean") return params.firecrawl.enabled;
  return Boolean(params.apiKey);
}

function resolveFirecrawlBaseUrl(firecrawl?: FirecrawlFetchConfig): string {
  const raw =
    firecrawl && "baseUrl" in firecrawl && typeof firecrawl.baseUrl === "string"
      ? firecrawl.baseUrl.trim()
      : "";
  return raw || DEFAULT_FIRECRAWL_BASE_URL;
}

function resolveFirecrawlOnlyMainContent(firecrawl?: FirecrawlFetchConfig): boolean {
  if (typeof firecrawl?.onlyMainContent === "boolean") return firecrawl.onlyMainContent;
  return true;
}

function resolveFirecrawlMaxAgeMs(firecrawl?: FirecrawlFetchConfig): number | undefined {
  const raw =
    firecrawl && "maxAgeMs" in firecrawl && typeof firecrawl.maxAgeMs === "number"
      ? firecrawl.maxAgeMs
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const parsed = Math.max(0, Math.floor(raw));
  return parsed > 0 ? parsed : undefined;
}

function resolveFirecrawlMaxAgeMsOrDefault(firecrawl?: FirecrawlFetchConfig): number {
  const resolved = resolveFirecrawlMaxAgeMs(firecrawl);
  if (typeof resolved === "number") return resolved;
  return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}

function missingSearchKeyPayload() {
  return {
    error: "missing_brave_api_key",
    message:
      "web_search needs a Brave Search API key. Run `clawdbot configure --section web` to store it, or set BRAVE_API_KEY in the Gateway environment.",
    docs: "https://docs.clawd.bot/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "brave") return "brave";
  return "brave";
}

function resolveTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.floor(parsed));
}

function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number {
  const minutes =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

function resolveMaxChars(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(100, Math.floor(parsed));
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

function readCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): { value: T; cached: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, cached: true };
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  if (ttlMs <= 0) return;
  if (cache.size >= DEFAULT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    insertedAt: Date.now(),
  });
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) return signal ?? new AbortController().signal;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) return href;
    return `[${label}](${href})`;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function readResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: (typeof EXTRACT_MODES)[number];
}): Promise<{ text: string; title?: string } | null> {
  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);
    const { document } = parseHTML(params.html);
    try {
      (document as { baseURI?: string }).baseURI = params.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) return null;
    const title = parsed.title || undefined;
    if (params.extractMode === "text") {
      const text = normalizeWhitespace(parsed.textContent ?? "");
      return { text, title };
    }
    const rendered = htmlToMarkdown(parsed.content);
    return { text: rendered.text, title: title ?? rendered.title };
  } catch {
    return null;
  }
}

export async function fetchFirecrawlContent(params: {
  url: string;
  extractMode: (typeof EXTRACT_MODES)[number];
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  proxy: "auto" | "basic" | "stealth";
  storeInCache: boolean;
  timeoutSeconds: number;
}): Promise<{
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}> {
  const endpoint = resolveFirecrawlEndpoint(params.baseUrl);
  const body: Record<string, unknown> = {
    url: params.url,
    formats: ["markdown"],
    onlyMainContent: params.onlyMainContent,
    timeout: params.timeoutSeconds * 1000,
    maxAge: params.maxAgeMs,
    proxy: params.proxy,
    storeInCache: params.storeInCache,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      content?: string;
      metadata?: {
        title?: string;
        sourceURL?: string;
        statusCode?: number;
      };
    };
    warning?: string;
    error?: string;
  };

  if (!res.ok || payload?.success === false) {
    const detail = payload?.error || res.statusText;
    throw new Error(`Firecrawl fetch failed (${res.status}): ${detail}`.trim());
  }

  const data = payload?.data ?? {};
  const rawText =
    typeof data.markdown === "string"
      ? data.markdown
      : typeof data.content === "string"
        ? data.content
        : "";
  const text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  return {
    text,
    title: data.metadata?.title,
    finalUrl: data.metadata?.sourceURL,
    status: data.metadata?.statusCode,
    warning: payload?.warning,
  };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  const start = Date.now();
  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.description ?? "",
    published: entry.age ?? undefined,
    siteName: resolveSiteName(entry.url ?? ""),
  }));

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runWebFetch(params: {
  url: string;
  extractMode: (typeof EXTRACT_MODES)[number];
  maxChars: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
  readabilityEnabled: boolean;
  firecrawlEnabled: boolean;
  firecrawlApiKey?: string;
  firecrawlBaseUrl: string;
  firecrawlOnlyMainContent: boolean;
  firecrawlMaxAgeMs: number;
  firecrawlProxy: "auto" | "basic" | "stealth";
  firecrawlStoreInCache: boolean;
  firecrawlTimeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(parsedUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "*/*",
        "User-Agent": params.userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: withTimeout(undefined, params.timeoutSeconds * 1000),
    });
  } catch (error) {
    if (params.firecrawlEnabled && params.firecrawlApiKey) {
      const firecrawl = await fetchFirecrawlContent({
        url: params.url,
        extractMode: params.extractMode,
        apiKey: params.firecrawlApiKey,
        baseUrl: params.firecrawlBaseUrl,
        onlyMainContent: params.firecrawlOnlyMainContent,
        maxAgeMs: params.firecrawlMaxAgeMs,
        proxy: params.firecrawlProxy,
        storeInCache: params.firecrawlStoreInCache,
        timeoutSeconds: params.firecrawlTimeoutSeconds,
      });
      const truncated = truncateText(firecrawl.text, params.maxChars);
      const payload = {
        url: params.url,
        finalUrl: firecrawl.finalUrl || params.url,
        status: firecrawl.status ?? 200,
        contentType: "text/markdown",
        title: firecrawl.title,
        extractMode: params.extractMode,
        extractor: "firecrawl",
        truncated: truncated.truncated,
        length: truncated.text.length,
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
        text: truncated.text,
        warning: firecrawl.warning,
      };
      writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }
    throw error;
  }

  if (!res.ok) {
    if (params.firecrawlEnabled && params.firecrawlApiKey) {
      const firecrawl = await fetchFirecrawlContent({
        url: params.url,
        extractMode: params.extractMode,
        apiKey: params.firecrawlApiKey,
        baseUrl: params.firecrawlBaseUrl,
        onlyMainContent: params.firecrawlOnlyMainContent,
        maxAgeMs: params.firecrawlMaxAgeMs,
        proxy: params.firecrawlProxy,
        storeInCache: params.firecrawlStoreInCache,
        timeoutSeconds: params.firecrawlTimeoutSeconds,
      });
      const truncated = truncateText(firecrawl.text, params.maxChars);
      const payload = {
        url: params.url,
        finalUrl: firecrawl.finalUrl || params.url,
        status: firecrawl.status ?? res.status,
        contentType: "text/markdown",
        title: firecrawl.title,
        extractMode: params.extractMode,
        extractor: "firecrawl",
        truncated: truncated.truncated,
        length: truncated.text.length,
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
        text: truncated.text,
        warning: firecrawl.warning,
      };
      writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }
    const detail = await readResponseText(res);
    throw new Error(`Web fetch failed (${res.status}): ${detail || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const body = await readResponseText(res);

  let title: string | undefined;
  let extractor = "raw";
  let text = body;
  if (contentType.includes("text/html")) {
    if (params.readabilityEnabled) {
      const readable = await extractReadableContent({
        html: body,
        url: res.url || params.url,
        extractMode: params.extractMode,
      });
      if (readable?.text) {
        text = readable.text;
        title = readable.title;
        extractor = "readability";
      } else {
        const firecrawl = await tryFirecrawlFallback(params);
        if (firecrawl) {
          text = firecrawl.text;
          title = firecrawl.title;
          extractor = "firecrawl";
        } else {
          throw new Error(
            "Web fetch extraction failed: Readability and Firecrawl returned no content.",
          );
        }
      }
    } else {
      throw new Error(
        "Web fetch extraction failed: Readability disabled and Firecrawl unavailable.",
      );
    }
  } else if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = "json";
    } catch {
      text = body;
      extractor = "raw";
    }
  }

  const truncated = truncateText(text, params.maxChars);
  const payload = {
    url: params.url,
    finalUrl: res.url || params.url,
    status: res.status,
    contentType,
    title,
    extractMode: params.extractMode,
    extractor,
    truncated: truncated.truncated,
    length: truncated.text.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
    text: truncated.text,
  };
  writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function tryFirecrawlFallback(params: {
  url: string;
  extractMode: (typeof EXTRACT_MODES)[number];
  firecrawlEnabled: boolean;
  firecrawlApiKey?: string;
  firecrawlBaseUrl: string;
  firecrawlOnlyMainContent: boolean;
  firecrawlMaxAgeMs: number;
  firecrawlProxy: "auto" | "basic" | "stealth";
  firecrawlStoreInCache: boolean;
  firecrawlTimeoutSeconds: number;
}): Promise<{ text: string; title?: string } | null> {
  if (!params.firecrawlEnabled || !params.firecrawlApiKey) return null;
  try {
    const firecrawl = await fetchFirecrawlContent({
      url: params.url,
      extractMode: params.extractMode,
      apiKey: params.firecrawlApiKey,
      baseUrl: params.firecrawlBaseUrl,
      onlyMainContent: params.firecrawlOnlyMainContent,
      maxAgeMs: params.firecrawlMaxAgeMs,
      proxy: params.firecrawlProxy,
      storeInCache: params.firecrawlStoreInCache,
      timeoutSeconds: params.firecrawlTimeoutSeconds,
    });
    return { text: firecrawl.text, title: firecrawl.title };
  } catch {
    return null;
  }
}

export function createWebSearchTool(options?: {
  config?: ClawdbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) return null;
  return {
    label: "Web Search",
    name: "web_search",
    description:
      "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const apiKey = resolveSearchApiKey(search);
      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload());
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider: resolveSearchProvider(search),
        country,
        search_lang,
        ui_lang,
      });
      return jsonResult(result);
    },
  };
}

function resolveFirecrawlEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") {
      return url.toString();
    }
    url.pathname = "/v2/scrape";
    return url.toString();
  } catch {
    return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  }
}

export function createWebFetchTool(options?: {
  config?: ClawdbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (!resolveFetchEnabled({ fetch, sandboxed: options?.sandboxed })) return null;
  const readabilityEnabled = resolveFetchReadabilityEnabled(fetch);
  const firecrawl = resolveFirecrawlConfig(fetch);
  const firecrawlApiKey = resolveFirecrawlApiKey(firecrawl);
  const firecrawlEnabled = resolveFirecrawlEnabled({ firecrawl, apiKey: firecrawlApiKey });
  const firecrawlBaseUrl = resolveFirecrawlBaseUrl(firecrawl);
  const firecrawlOnlyMainContent = resolveFirecrawlOnlyMainContent(firecrawl);
  const firecrawlMaxAgeMs = resolveFirecrawlMaxAgeMsOrDefault(firecrawl);
  const firecrawlTimeoutSeconds = resolveTimeoutSeconds(
    firecrawl?.timeoutSeconds ?? fetch?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const userAgent =
    (fetch && "userAgent" in fetch && typeof fetch.userAgent === "string" && fetch.userAgent) ||
    DEFAULT_FETCH_USER_AGENT;
  return {
    label: "Web Fetch",
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.",
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const extractMode = readStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(params, "maxChars", { integer: true });
      const result = await runWebFetch({
        url,
        extractMode,
        maxChars: resolveMaxChars(maxChars ?? fetch?.maxChars, DEFAULT_FETCH_MAX_CHARS),
        timeoutSeconds: resolveTimeoutSeconds(fetch?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(fetch?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        userAgent,
        readabilityEnabled,
        firecrawlEnabled,
        firecrawlApiKey,
        firecrawlBaseUrl,
        firecrawlOnlyMainContent,
        firecrawlMaxAgeMs,
        firecrawlProxy: "auto",
        firecrawlStoreInCache: true,
        firecrawlTimeoutSeconds,
      });
      return jsonResult(result);
    },
  };
}
