import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_QVERIS_BASE_URL = "https://qveris.ai/api/v1";
const DEFAULT_SEARCH_TIMEOUT_SECONDS = 5;
const DEFAULT_EXECUTE_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_RESPONSE_SIZE = 20480;
const DEFAULT_SEARCH_LIMIT = 10;

// Short-TTL cache for search results — avoids redundant API calls within a session
const DEFAULT_SEARCH_CACHE_TTL_MS = 90_000; // 90 seconds

// ============================================================================
// Types
// ============================================================================

type QverisConfig = NonNullable<OpenClawConfig["tools"]>["qveris"];

/** Search result parameter from QVeris API */
interface QverisSearchResultParam {
  name: string;
  type: string;
  required: boolean;
  description?: {
    en?: string;
    [key: string]: string | undefined;
  };
}

/** Example format from QVeris search API */
interface QverisSearchResultExamples {
  sample_parameters?: Record<string, unknown>;
}

/** Search result tool from QVeris API */
interface QverisSearchResultTool {
  tool_id: string;
  name: string;
  description: string;
  params?: QverisSearchResultParam[];
  provider_description?: string;
  stats?: {
    avg_execution_time_ms?: number;
    success_rate?: number;
  };
  examples?: QverisSearchResultExamples;
}

/** QVeris search API response */
interface QverisSearchResponse {
  query: string;
  total: number;
  results: QverisSearchResultTool[];
  search_id: string;
  elapsed_time_ms?: number;
}

/** QVeris tool execution response */
interface QverisExecutionResponse {
  execution_id: string;
  result: {
    data?: unknown;
    status_code?: unknown;
    message?: unknown;
    full_content_file_url?: unknown;
    truncated_content?: unknown;
    content_schema?: unknown;
  };
  success: boolean;
  error_message: string | null;
  elapsed_time_ms: number;
  cost?: number;
  credits_used?: number;
}

/** Structured error returned to the model instead of throwing */
interface QverisErrorResult {
  success: false;
  error_type: "timeout" | "http_error" | "network_error" | "json_parse_error";
  status?: number;
  detail: string;
  retry_hint?: string;
}

// ============================================================================
// Config Resolution
// ============================================================================

function resolveQverisConfig(cfg?: OpenClawConfig): QverisConfig {
  return cfg?.tools?.qveris;
}

function resolveQverisEnabled(params: { config?: QverisConfig; sandboxed?: boolean }): boolean {
  if (typeof params.config?.enabled === "boolean") {
    return params.config.enabled;
  }
  // Enabled by default if API key is present
  return Boolean(resolveQverisApiKey(params.config));
}

function resolveQverisApiKey(config?: QverisConfig): string | undefined {
  const fromConfig =
    config && "apiKey" in config && typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const fromEnv = (process.env.QVERIS_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveQverisBaseUrl(config?: QverisConfig): string {
  return config?.baseUrl?.trim() || DEFAULT_QVERIS_BASE_URL;
}

function resolveSearchTimeoutSeconds(config?: QverisConfig): number {
  // searchTimeoutSeconds takes precedence; fall back to legacy timeoutSeconds
  return config?.searchTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_SEARCH_TIMEOUT_SECONDS;
}

function resolveExecuteTimeoutSeconds(config?: QverisConfig): number {
  // executeTimeoutSeconds takes precedence; fall back to legacy timeoutSeconds
  return config?.executeTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_EXECUTE_TIMEOUT_SECONDS;
}

function resolveMaxResponseSize(config?: QverisConfig): number {
  return config?.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
}

function resolveSearchLimit(config?: QverisConfig): number {
  return config?.searchLimit ?? DEFAULT_SEARCH_LIMIT;
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classifies a caught error from a QVeris API call into a structured result
 * so the model receives a consistent error format rather than an exception trace.
 */
export function classifyQverisError(err: unknown): QverisErrorResult {
  // AbortError from AbortController timeout
  if (err instanceof DOMException && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
    };
  }
  // Node fetch AbortError arrives as a plain Error with name === 'AbortError'
  if (err instanceof Error && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
    };
  }
  if (err instanceof Error) {
    // Preserve HTTP status codes encoded in the message from qverisSearch/qverisExecute
    const httpMatch = err.message.match(/\((\d{3})\)/);
    if (httpMatch) {
      const status = Number(httpMatch[1]);
      const isClientError = status >= 400 && status < 500;
      return {
        success: false,
        error_type: "http_error",
        status,
        detail: err.message,
        retry_hint: isClientError
          ? "Check tool_id, search_id, and params_to_tool structure."
          : "QVeris service error — retry in a moment.",
      };
    }
    return {
      success: false,
      error_type: "network_error",
      detail: err.message,
      retry_hint: "Check network connectivity and retry.",
    };
  }
  return {
    success: false,
    error_type: "network_error",
    detail: String(err),
    retry_hint: "Check network connectivity and retry.",
  };
}

// ============================================================================
// In-Memory Search Cache
// ============================================================================

interface SearchCacheEntry {
  value: ReturnType<typeof jsonResult>;
  expiresAt: number;
}

function makeSearchCache() {
  const store = new Map<string, SearchCacheEntry>();

  function read(key: string): SearchCacheEntry["value"] | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function write(key: string, value: SearchCacheEntry["value"], ttlMs: number) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return { read, write };
}

// ============================================================================
// API Client
// ============================================================================

async function qverisSearch(params: {
  query: string;
  sessionId: string;
  limit: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisSearchResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(`${params.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        limit: params.limit,
        session_id: params.sessionId,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`QVeris search failed (${res.status}): ${detail || res.statusText}`);
    }

    return (await res.json()) as QverisSearchResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function qverisExecute(params: {
  toolId: string;
  searchId: string;
  sessionId: string;
  parameters: Record<string, unknown>;
  maxResponseSize: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisExecutionResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(
      `${params.baseUrl}/tools/execute?tool_id=${encodeURIComponent(params.toolId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          parameters: params.parameters,
          max_response_size: params.maxResponseSize,
          search_id: params.searchId,
          session_id: params.sessionId,
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`QVeris execute failed (${res.status}): ${detail || res.statusText}`);
    }

    return (await res.json()) as QverisExecutionResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Tool Schemas
// ============================================================================

const QverisSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Search query describing the capability of the tool you need. Describe what you want to accomplish, not specific params to pass. Example: 'weather forecast API', 'send email', 'stock prices'.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (1-100). Default: 10.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

const QverisExecuteSchema = Type.Object({
  tool_id: Type.String({
    description: "The ID of the tool to execute. Must come from a previous qveris_search call.",
  }),
  search_id: Type.String({
    description:
      "The search_id from the qveris_search response that returned this tool. Required for linking execution to the original search.",
  }),
  params_to_tool: Type.String({
    description:
      'JSON dictionary of parameters to pass to the tool. IMPORTANT: Use the sample_parameters from the qveris_search results as your template — copy its structure and replace values with the actual data needed. Example: \'{"city": "London", "units": "metric"}\'.',
  }),
  max_response_size: Type.Optional(
    Type.Number({
      description:
        "Maximum size of response data in bytes. If tool generates data longer than this, it will be truncated. Default: 20480 (20KB).",
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Override timeout in seconds for this execution. Short tasks (data queries, search): default 10s. Long tasks (image/video generation, multimodal processing): set 60-120s. Default: 60.",
      minimum: 1,
      maximum: 300,
    }),
  ),
});

// ============================================================================
// Tool Creation
// ============================================================================

export function createQverisTools(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  agentSessionKey?: string;
}): AnyAgentTool[] {
  const config = resolveQverisConfig(options?.config);

  if (!resolveQverisEnabled({ config, sandboxed: options?.sandboxed })) {
    return [];
  }

  const apiKey = resolveQverisApiKey(config);
  if (!apiKey) {
    // Return empty array if no API key - tools won't be available
    return [];
  }

  const baseUrl = resolveQverisBaseUrl(config);
  const searchTimeoutSeconds = resolveSearchTimeoutSeconds(config);
  const executeTimeoutSeconds = resolveExecuteTimeoutSeconds(config);
  const maxResponseSize = resolveMaxResponseSize(config);
  const searchLimit = resolveSearchLimit(config);

  // Session-scoped search cache — avoids redundant API calls within a conversation
  const searchCache = makeSearchCache();

  // Generate a session ID tied to clawdbot session key
  const sessionId = options?.agentSessionKey ?? `clawdbot-${Date.now()}-${randomUUID()}`;

  const searchTool: AnyAgentTool = {
    label: "QVeris Search",
    name: "qveris_search",
    description:
      "Search for available third-party tools using natural language. Returns relevant tools that can help accomplish tasks. Use this to discover tools before executing them with qveris_execute.",
    parameters: QverisSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? searchLimit;
      const normalizedLimit = Math.min(Math.max(1, limit), 100);

      // Check cache first
      const cacheKey = `${query}:${normalizedLimit}`;
      const cached = searchCache.read(cacheKey);
      if (cached) {
        return { ...cached, cached: true } as ReturnType<typeof jsonResult>;
      }

      let result: QverisSearchResponse;
      try {
        result = await qverisSearch({
          query,
          sessionId,
          limit: normalizedLimit,
          apiKey,
          baseUrl,
          timeoutSeconds: searchTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      // Return simplified result for the model
      const payload = jsonResult({
        query: result.query,
        total: result.total,
        search_id: result.search_id,
        elapsed_time_ms: result.elapsed_time_ms,
        results: result.results.map((tool) => ({
          tool_id: tool.tool_id,
          name: tool.name,
          description: tool.description,
          provider_description: tool.provider_description,
          params: tool.params?.map((p) => ({
            name: p.name,
            type: p.type,
            required: p.required,
            description: p.description?.en ?? Object.values(p.description ?? {})[0],
          })),
          examples: tool.examples?.sample_parameters
            ? { sample_parameters: tool.examples.sample_parameters }
            : undefined,
          stats: tool.stats,
        })),
      });

      searchCache.write(cacheKey, payload, DEFAULT_SEARCH_CACHE_TTL_MS);
      return payload;
    },
  };

  const executeTool: AnyAgentTool = {
    label: "QVeris Execute",
    name: "qveris_execute",
    description:
      "Execute a specific third-party tool with provided parameters. The tool_id and search_id must come from a previous qveris_search call. Pass parameters to the tool through params_to_tool as a JSON string.",
    parameters: QverisExecuteSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolId = readStringParam(params, "tool_id", { required: true });
      const searchId = readStringParam(params, "search_id", { required: true });
      const paramsToToolRaw = readStringParam(params, "params_to_tool", { required: true });
      const maxSize =
        readNumberParam(params, "max_response_size", { integer: true }) ?? maxResponseSize;
      const timeoutOverride = readNumberParam(params, "timeout_seconds");

      // Parse params_to_tool JSON; return structured error instead of throwing
      let toolParams: Record<string, unknown>;
      try {
        toolParams = JSON.parse(paramsToToolRaw) as Record<string, unknown>;
      } catch (parseError) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error",
          detail: `Invalid JSON in params_to_tool: ${parseError instanceof Error ? parseError.message : "Unknown parse error"}`,
          retry_hint:
            "Use sample_parameters from the qveris_search result as a template and ensure valid JSON.",
        } satisfies QverisErrorResult);
      }

      let result: QverisExecutionResponse;
      try {
        result = await qverisExecute({
          toolId,
          searchId,
          sessionId,
          parameters: toolParams,
          maxResponseSize: maxSize,
          apiKey,
          baseUrl,
          timeoutSeconds: timeoutOverride ?? executeTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      return jsonResult({
        execution_id: result.execution_id,
        success: result.success,
        elapsed_time_ms: result.elapsed_time_ms,
        result: result.result?.data,
        error_message: result.error_message,
        cost: result.cost ?? result.credits_used,
      });
    },
  };

  return [searchTool, executeTool];
}

/**
 * Check if QVeris tools are enabled/available
 */
export function isQverisEnabled(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): boolean {
  const config = resolveQverisConfig(options?.config);
  return (
    resolveQverisEnabled({ config, sandboxed: options?.sandboxed }) &&
    Boolean(resolveQverisApiKey(config))
  );
}
