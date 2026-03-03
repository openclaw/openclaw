import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  fetchFirecrawlContent,
  resolveFetchConfig,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
  resolveFirecrawlConfig,
  resolveFirecrawlMaxAgeMsOrDefault,
  resolveFirecrawlOnlyMainContent,
} from "./web-fetch.js";
import { DEFAULT_TIMEOUT_SECONDS, resolveTimeoutSeconds, withTimeout } from "./web-shared.js";

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

const FirecrawlSearchSchema = Type.Object({
  query: Type.String({ description: "Search query." }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (1-20, default 5).",
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
    }),
  ),
});

const FirecrawlScrapeSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to scrape." }),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded).",
      minimum: 100,
    }),
  ),
});

function resolveSearchEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const base = trimmed || "https://api.firecrawl.dev";
  try {
    const url = new URL(base);
    url.pathname = "/v2/search";
    return url.toString();
  } catch {
    return "https://api.firecrawl.dev/v2/search";
  }
}

type FirecrawlSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
};

type FirecrawlSearchResponse = {
  success?: boolean;
  /** v2: data is { web: [...], news?: [...], images?: [...] } */
  data?: { web?: FirecrawlSearchResult[] } | FirecrawlSearchResult[];
  error?: string;
};

export function createFirecrawlSearchTool(options?: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  const firecrawl = resolveFirecrawlConfig(fetch);
  const apiKey = resolveFirecrawlApiKey(firecrawl);
  if (!apiKey) {
    return null;
  }
  const baseUrl = resolveFirecrawlBaseUrl(firecrawl);
  const timeoutSeconds = resolveTimeoutSeconds(firecrawl?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);

  return {
    label: "Firecrawl Search",
    name: "firecrawl_search",
    description:
      "Search the web using Firecrawl and return results with optional scraped content. Use for web research when you need search results with clean markdown.",
    parameters: FirecrawlSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const rawLimit = readNumberParam(params, "limit", { integer: true });
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, rawLimit ?? DEFAULT_SEARCH_LIMIT));

      const endpoint = resolveSearchEndpoint(baseUrl);
      const res = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, limit }),
        signal: withTimeout(undefined, timeoutSeconds * 1000),
      });

      const payload = (await res.json()) as FirecrawlSearchResponse;

      if (!res.ok || payload?.success === false) {
        const detail = payload?.error ?? res.statusText;
        throw new Error(`Firecrawl search failed (${res.status}): ${detail}`);
      }

      // v2 returns { data: { web: [...] } }, v1 returned { data: [...] }
      const rawData = payload?.data;
      const items: FirecrawlSearchResult[] = Array.isArray(rawData)
        ? rawData
        : ((rawData as { web?: FirecrawlSearchResult[] })?.web ?? []);
      const results = items.map((item) => ({
        title: item.title
          ? wrapExternalContent(item.title, { source: "web_search", includeWarning: false })
          : undefined,
        url: item.url, // Keep raw for tool chaining
        description: item.description
          ? wrapExternalContent(item.description, { source: "web_search", includeWarning: false })
          : undefined,
        markdown: item.markdown ? wrapWebContent(item.markdown, "web_fetch") : undefined,
      }));

      return jsonResult({
        query,
        results,
        externalContent: {
          untrusted: true,
          source: "firecrawl_search",
          wrapped: true,
        },
      });
    },
  };
}

const DEFAULT_SCRAPE_MAX_CHARS = 50_000;

export function createFirecrawlScrapeTool(options?: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  const firecrawl = resolveFirecrawlConfig(fetch);
  const apiKey = resolveFirecrawlApiKey(firecrawl);
  if (!apiKey) {
    return null;
  }
  const baseUrl = resolveFirecrawlBaseUrl(firecrawl);
  const onlyMainContent = resolveFirecrawlOnlyMainContent(firecrawl);
  const maxAgeMs = resolveFirecrawlMaxAgeMsOrDefault(firecrawl);
  const timeoutSeconds = resolveTimeoutSeconds(firecrawl?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);

  return {
    label: "Firecrawl Scrape",
    name: "firecrawl_scrape",
    description:
      "Scrape a URL using Firecrawl and return clean markdown content. Use for extracting readable content from web pages, especially those requiring JS rendering.",
    parameters: FirecrawlScrapeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const rawMaxChars = readNumberParam(params, "maxChars", { integer: true });
      const maxChars = Math.max(100, rawMaxChars ?? DEFAULT_SCRAPE_MAX_CHARS);

      const result = await fetchFirecrawlContent({
        url,
        extractMode: "markdown",
        apiKey,
        baseUrl,
        onlyMainContent,
        maxAgeMs,
        proxy: "auto",
        storeInCache: true,
        timeoutSeconds,
      });

      const text = result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text;

      return jsonResult({
        url,
        finalUrl: result.finalUrl,
        status: result.status,
        title: result.title
          ? wrapExternalContent(result.title, { source: "web_fetch", includeWarning: false })
          : undefined,
        text: wrapWebContent(text, "web_fetch"),
        truncated: result.text.length > maxChars,
        externalContent: {
          untrusted: true,
          source: "firecrawl_scrape",
          wrapped: true,
        },
        warning: result.warning,
      });
    },
  };
}
