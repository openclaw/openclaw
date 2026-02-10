import type { OpenClawConfig } from "../../config/config.js";
import type { CacheEntry } from "./web-shared.js";
import { wrapWebContent } from "../../security/external-content.js";
import { runAtlasPrompt } from "./atlas.js";
import { normalizeCacheKey, readCache, writeCache } from "./web-shared.js";

type AtlasSearchEntry = {
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
};

function resolveAtlasSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function formatAtlasFreshnessHint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "pd") {
    return "past 24 hours";
  }
  if (value === "pw") {
    return "past week";
  }
  if (value === "pm") {
    return "past month";
  }
  if (value === "py") {
    return "past year";
  }
  if (value.includes("to")) {
    return value.replace("to", " to ");
  }
  return value;
}

function buildAtlasSearchPrompt(params: {
  query: string;
  count: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
}): string {
  const hints: string[] = [];
  if (params.country) {
    hints.push(`Prefer results from country: ${params.country}.`);
  }
  if (params.searchLang) {
    hints.push(`Prefer sources in language: ${params.searchLang}.`);
  }
  if (params.uiLang) {
    hints.push(`Prefer UI language: ${params.uiLang}.`);
  }
  const freshnessHint = formatAtlasFreshnessHint(params.freshness);
  if (freshnessHint) {
    hints.push(`Prefer results from: ${freshnessHint}.`);
  }

  return [
    "You are a web search assistant.",
    `Search the web for: "${params.query}".`,
    `Return up to ${params.count} results as JSON with shape: {"results":[{"title":"","url":"","snippet":""}]}.`,
    "Use full http(s) URLs.",
    ...hints,
    "If you cannot access the web, still return known official URLs and mark snippets with 'offline'.",
    "Return only JSON, no markdown or code fences.",
  ].join("\n");
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = withoutFence.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through
    }
  }
  const firstBracket = withoutFence.indexOf("[");
  const lastBracket = withoutFence.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = withoutFence.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore
    }
  }
  return null;
}

function normalizeAtlasSearchResults(value: unknown, maxCount: number): AtlasSearchEntry[] {
  if (!value) {
    return [];
  }
  const rawResults = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "results" in value
      ? (value as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const entries: AtlasSearchEntry[] = [];
  for (const entry of rawResults) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const url =
      typeof item.url === "string" ? item.url : typeof item.link === "string" ? item.link : "";
    const snippet =
      typeof item.snippet === "string"
        ? item.snippet
        : typeof item.description === "string"
          ? item.description
          : typeof item.summary === "string"
            ? item.summary
            : "";
    entries.push({ title, url, snippet });
  }
  return entries.slice(0, maxCount);
}

function extractUrlsFromText(text: string): string[] {
  const urls = new Set<string>();
  const regex = /https?:\/\/[^\s)]+/gi;
  for (const match of text.matchAll(regex)) {
    const raw = match[0]?.trim() ?? "";
    if (!raw) {
      continue;
    }
    const cleaned = raw.replace(/[).,;]+$/, "");
    urls.add(cleaned);
  }
  return Array.from(urls);
}

export async function runAtlasSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  cache: Map<string, CacheEntry<Record<string, unknown>>>;
  config?: OpenClawConfig;
  sandboxed?: boolean;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `atlas:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`,
  );
  const cached = readCache(params.cache, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const prompt = buildAtlasSearchPrompt({
    query: params.query,
    count: params.count,
    country: params.country,
    searchLang: params.search_lang,
    uiLang: params.ui_lang,
    freshness: params.freshness,
  });
  const response = await runAtlasPrompt({
    config: params.config,
    sandboxed: params.sandboxed,
    prompt,
    timeoutMs: params.timeoutSeconds * 1000,
  });
  const parsed = extractJsonPayload(response.text);
  const normalized = normalizeAtlasSearchResults(parsed, params.count);
  const fallbackUrls: AtlasSearchEntry[] = normalized.length
    ? []
    : extractUrlsFromText(response.text).map((url) => ({ url }));
  const entries: AtlasSearchEntry[] = normalized.length ? normalized : fallbackUrls;
  const mapped = entries
    .map((entry) => {
      const description = entry.snippet ?? entry.description ?? "";
      const title = entry.title ?? "";
      const url = entry.url ?? "";
      const rawSiteName = resolveAtlasSiteName(url);
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url, // Keep raw for tool chaining
        description: description ? wrapWebContent(description, "web_search") : "",
        siteName: rawSiteName || undefined,
      };
    })
    .filter((entry) => Boolean(entry.url));

  const payload = {
    query: params.query,
    provider: "atlas",
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(params.cache, cacheKey, payload, params.cacheTtlMs);
  return payload;
}
