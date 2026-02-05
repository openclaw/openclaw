import { Type } from "@sinclair/typebox";

import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_CLIENT_NAME = "openclaw";
const MCP_CLIENT_VERSION = "1.0.0";
const DEFAULT_MCP_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WebSearchPrimeSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (1-20).",
      minimum: 1,
      maximum: MAX_RESULTS,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

type WebSearchPrimeConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { searchPrime?: infer SP }
    ? SP
    : undefined
  : undefined;

function resolveConfig(cfg?: OpenClawConfig): WebSearchPrimeConfig {
  const sp = (cfg?.tools?.web as Record<string, unknown> | undefined)?.searchPrime;
  if (!sp || typeof sp !== "object") return undefined;
  return sp as WebSearchPrimeConfig;
}

function resolveEnabled(config?: WebSearchPrimeConfig): boolean {
  if (typeof config?.enabled === "boolean") return config.enabled;
  // Enabled by default when apiKey is available.
  return !!resolveApiKey(config);
}

function resolveApiKey(config?: WebSearchPrimeConfig): string | undefined {
  const fromConfig =
    config && "apiKey" in config && typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const fromEnv = (process.env.GLM_API_KEY ?? process.env.ZHIPU_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveMcpUrl(config?: WebSearchPrimeConfig): string {
  const fromConfig =
    config && "url" in config && typeof config.url === "string" ? config.url.trim() : "";
  return fromConfig || DEFAULT_MCP_URL;
}

// ---------------------------------------------------------------------------
// MCP Streamable HTTP client (minimal, single-tool oriented)
// ---------------------------------------------------------------------------

type McpSession = {
  sessionId: string;
  createdAt: number;
};

/** Module-level MCP session cache, keyed by endpoint URL. */
const mcpSessions = new Map<string, McpSession>();

/** Maximum session age before re-initializing (10 minutes). */
const SESSION_MAX_AGE_MS = 10 * 60_000;

async function mcpRequest(params: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  sessionId?: string;
  timeoutMs: number;
}): Promise<{ json: Record<string, unknown> | null; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${params.apiKey}`,
  };
  if (params.sessionId) {
    headers["Mcp-Session-Id"] = params.sessionId;
  }

  const res = await fetch(params.url, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
    signal: withTimeout(undefined, params.timeoutMs),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`MCP request error (${res.status}): ${detail || res.statusText}`);
  }

  const sessionId = res.headers.get("Mcp-Session-Id") ?? params.sessionId;
  const contentType = res.headers.get("Content-Type") ?? "";

  // JSON-RPC notifications may return 204/202 with no body.
  const contentLength = res.headers.get("Content-Length");
  if (res.status === 204 || res.status === 202 || contentLength === "0") {
    return { json: null, sessionId: sessionId ?? undefined };
  }

  let json: Record<string, unknown>;
  if (contentType.includes("text/event-stream")) {
    // Parse SSE: find last "data:" line that contains a JSON-RPC response.
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        lastData = line.slice(5).trim();
      }
    }
    if (!lastData) throw new Error("Empty SSE response from MCP server");
    json = JSON.parse(lastData) as Record<string, unknown>;
  } else {
    json = (await res.json()) as Record<string, unknown>;
  }

  return { json, sessionId: sessionId ?? undefined };
}

async function ensureMcpSession(params: {
  url: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<string> {
  const existing = mcpSessions.get(params.url);
  if (existing && Date.now() - existing.createdAt < SESSION_MAX_AGE_MS) {
    return existing.sessionId;
  }

  // Step 1: initialize
  const initRes = await mcpRequest({
    url: params.url,
    apiKey: params.apiKey,
    timeoutMs: params.timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
    },
  });

  const sessionId = initRes.sessionId;
  if (!sessionId) throw new Error("MCP server did not return Mcp-Session-Id");

  // Step 2: notifications/initialized
  await mcpRequest({
    url: params.url,
    apiKey: params.apiKey,
    sessionId,
    timeoutMs: params.timeoutMs,
    body: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  });

  mcpSessions.set(params.url, { sessionId, createdAt: Date.now() });
  return sessionId;
}

async function callMcpTool(params: {
  url: string;
  apiKey: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const res = await mcpRequest({
    url: params.url,
    apiKey: params.apiKey,
    sessionId: params.sessionId,
    timeoutMs: params.timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: params.toolName,
        arguments: params.args,
      },
    },
  });

  const result = res.json.result as Record<string, unknown> | undefined;
  const error = res.json.error as Record<string, unknown> | undefined;
  if (error) {
    throw new Error(`MCP tool error: ${JSON.stringify(error)}`);
  }
  return result ?? res.json;
}

// ---------------------------------------------------------------------------
// Search result parsing
// ---------------------------------------------------------------------------

type SearchResultItem = {
  title?: string;
  url?: string;
  content?: string;
  icon?: string;
  media?: string;
  refer?: string;
};

function parseSearchResults(mcpResult: Record<string, unknown>): {
  results: SearchResultItem[];
  raw?: string;
} {
  const content = mcpResult.content;
  if (!Array.isArray(content)) {
    return { results: [], raw: JSON.stringify(mcpResult) };
  }

  // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
  const textParts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  const fullText = textParts.join("\n");

  // Try to parse as JSON array of search results.
  try {
    // GLM API may return results wrapped in extra quotes: "[{...}]"
    let textToParse = fullText.trim();
    if (textToParse.startsWith('"') && textToParse.endsWith('"')) {
      // Remove outer quotes
      textToParse = textToParse.slice(1, -1);
      // Unescape escaped quotes
      textToParse = textToParse.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    const parsed = JSON.parse(textToParse);
    if (Array.isArray(parsed)) {
      return {
        results: parsed.map((item: Record<string, unknown>) => ({
          title: typeof item.title === "string" ? item.title : undefined,
          url:
            typeof item.link === "string"
              ? item.link
              : typeof item.url === "string"
                ? item.url
                : undefined,
          content: typeof item.content === "string" ? item.content : undefined,
          icon: typeof item.icon === "string" ? item.icon : undefined,
          media: typeof item.media === "string" ? item.media : undefined,
          refer: typeof item.refer === "string" ? item.refer : undefined,
        })),
      };
    }
    // If it's an object with a results/items field.
    if (parsed && typeof parsed === "object") {
      const items = parsed.results ?? parsed.items ?? parsed.data;
      if (Array.isArray(items)) {
        return { results: items as SearchResultItem[] };
      }
    }
  } catch {
    // Not JSON; return raw text.
  }

  return { results: [], raw: fullText };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWebSearchPrimeTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const config = resolveConfig(options?.config);
  if (!resolveEnabled(config)) return null;

  const apiKey = resolveApiKey(config);
  const mcpUrl = resolveMcpUrl(config);
  const timeoutSeconds = resolveTimeoutSeconds(config?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(config?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);

  return {
    label: "Web Search (GLM)",
    name: "web_search_prime",
    description:
      "Search the web using GLM web-search-prime (via MCP). Returns page titles, URLs, summaries, site names, and icons. Use this for real-time web information when the built-in web_search tool is unavailable.",
    parameters: WebSearchPrimeSchema,
    execute: async (_toolCallId, args) => {
      if (!apiKey) {
        return jsonResult({
          error: "missing_glm_api_key",
          message:
            "web_search_prime needs a GLM API key. Set GLM_API_KEY or ZHIPU_API_KEY in the environment, or configure tools.web.searchPrime.apiKey.",
        });
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count = readNumberParam(params, "count", { integer: true }) ?? DEFAULT_MAX_RESULTS;

      // Cache check.
      const cacheKey = normalizeCacheKey(`glm:${query}:${count}`);
      const cached = readCache(SEARCH_CACHE, cacheKey);
      if (cached) return jsonResult({ ...cached.value, cached: true });

      const start = Date.now();
      const timeoutMs = timeoutSeconds * 1000;

      try {
        // Ensure MCP session is active.
        const sessionId = await ensureMcpSession({ url: mcpUrl, apiKey, timeoutMs });

        // Call the webSearchPrime tool via MCP.
        // Note: GLM MCP API uses "search_query" instead of "query"
        const mcpResult = await callMcpTool({
          url: mcpUrl,
          apiKey,
          sessionId,
          toolName: "webSearchPrime",
          args: { search_query: query },
          timeoutMs,
        });

        const { results, raw } = parseSearchResults(mcpResult);
        const payload: Record<string, unknown> = {
          query,
          provider: "glm-web-search-prime",
          count: results.length,
          tookMs: Date.now() - start,
        };

        if (results.length > 0) {
          payload.results = results;
        } else if (raw) {
          payload.content = raw;
        }

        writeCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
        return jsonResult(payload);
      } catch {
        // Session may have expired; clear and retry once.
        mcpSessions.delete(mcpUrl);
        try {
          const sessionId = await ensureMcpSession({ url: mcpUrl, apiKey, timeoutMs });
          const mcpResult = await callMcpTool({
            url: mcpUrl,
            apiKey,
            sessionId,
            toolName: "webSearchPrime",
            args: { search_query: query },
            timeoutMs,
          });

          const { results, raw } = parseSearchResults(mcpResult);
          const payload: Record<string, unknown> = {
            query,
            provider: "glm-web-search-prime",
            count: results.length,
            tookMs: Date.now() - start,
          };

          if (results.length > 0) {
            payload.results = results;
          } else if (raw) {
            payload.content = raw;
          }

          writeCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
          return jsonResult(payload);
        } catch (retryErr) {
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return jsonResult({
            error: "web_search_prime_failed",
            message,
            query,
            tookMs: Date.now() - start,
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------

export const __testing = {
  resolveConfig,
  resolveEnabled,
  resolveApiKey,
  resolveMcpUrl,
  parseSearchResults,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS,
  DEFAULT_MCP_URL,
  MCP_PROTOCOL_VERSION,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
};
