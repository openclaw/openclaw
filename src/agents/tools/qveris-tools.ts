import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_QVERIS_BASE_URL = "https://qveris.ai/api/v1";
const DEFAULT_DISCOVER_TIMEOUT_SECONDS = 5;
const DEFAULT_INVOKE_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_RESPONSE_SIZE = 20480;
const DEFAULT_DISCOVER_LIMIT = 10;

// Short-TTL cache for discover results — avoids redundant API calls within a session
const DEFAULT_DISCOVER_CACHE_TTL_MS = 90_000; // 90 seconds

// ============================================================================
// Types
// ============================================================================

type QverisConfig = NonNullable<OpenClawConfig["tools"]>["qveris"];

/** Discovery result parameter from QVeris API */
interface QverisDiscoverResultParam {
  name: string;
  type: string;
  required: boolean;
  description?: {
    en?: string;
    [key: string]: string | undefined;
  };
}

/** Example format from QVeris discovery API */
interface QverisDiscoverResultExamples {
  sample_parameters?: Record<string, unknown>;
}

/** Discovery result tool from QVeris API */
interface QverisDiscoverResultTool {
  tool_id: string;
  name: string;
  description: string;
  params?: QverisDiscoverResultParam[];
  provider_description?: string;
  stats?: {
    avg_execution_time_ms?: number;
    success_rate?: number;
  };
  examples?: QverisDiscoverResultExamples;
}

/** QVeris discover API response */
interface QverisDiscoverResponse {
  query: string;
  total: number;
  results: QverisDiscoverResultTool[];
  search_id: string; // backend field name; exposed to model as discovery_id
  elapsed_time_ms?: number;
}

/** QVeris tool invocation response */
interface QverisInvocationResponse {
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
  error_type: "timeout" | "http_error" | "network_error" | "json_parse_error" | "rate_limited";
  status?: number;
  detail: string;
  retry_hint?: string;
  retry_after_seconds?: number;
  recovery_step?: "fix_params" | "simplify" | "switch_tool";
  attempt_number?: number;
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

function resolveDiscoverTimeoutSeconds(config?: QverisConfig): number {
  return config?.searchTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_DISCOVER_TIMEOUT_SECONDS;
}

function resolveInvokeTimeoutSeconds(config?: QverisConfig): number {
  return config?.executeTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_INVOKE_TIMEOUT_SECONDS;
}

function resolveMaxResponseSize(config?: QverisConfig): number {
  return config?.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
}

function resolveDiscoverLimit(config?: QverisConfig): number {
  return config?.searchLimit ?? DEFAULT_DISCOVER_LIMIT;
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classifies a caught error from a QVeris API call into a structured result
 * so the model receives a consistent error format rather than an exception trace.
 */
export function classifyQverisError(err: unknown): QverisErrorResult {
  if (err instanceof DOMException && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
    };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
    };
  }
  if (err instanceof Error) {
    const httpMatch = err.message.match(/\((\d{3})\)/);
    if (httpMatch) {
      const status = Number(httpMatch[1]);

      // Rate-limit: parse Retry-After encoded by the API client
      if (status === 429) {
        const retryMatch = err.message.match(/\[retry-after:(\d+)]/);
        const waitSeconds = retryMatch ? Number(retryMatch[1]) : 10;
        return {
          success: false,
          error_type: "rate_limited",
          status: 429,
          detail: err.message.replace(/\s*\[retry-after:\d+]/, ""),
          retry_after_seconds: waitSeconds,
          retry_hint: `Rate limited. Wait ${waitSeconds}s before retrying.`,
        };
      }

      const isClientError = status >= 400 && status < 500;
      return {
        success: false,
        error_type: "http_error",
        status,
        detail: err.message,
        retry_hint: isClientError
          ? "Check tool_id, discovery_id (from qveris_discover or qveris_inspect), and params_to_tool structure."
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
// In-Memory Discover Cache
// ============================================================================

interface DiscoverCacheEntry {
  value: ReturnType<typeof jsonResult>;
  expiresAt: number;
}

function makeDiscoverCache() {
  const store = new Map<string, DiscoverCacheEntry>();

  function read(key: string): DiscoverCacheEntry["value"] | undefined {
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

  function write(key: string, value: DiscoverCacheEntry["value"], ttlMs: number) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return { read, write };
}

// ============================================================================
// API Client
// ============================================================================

/** Encode Retry-After into the error message so classifyQverisError can parse it */
function buildApiError(label: string, res: Response, detail: string): Error {
  const retryAfter = res.headers.get("Retry-After");
  const retryTag = retryAfter ? ` [retry-after:${retryAfter}]` : "";
  return new Error(
    `QVeris ${label} failed (${res.status}): ${detail || res.statusText}${retryTag}`,
  );
}

async function qverisDiscover(params: {
  query: string;
  sessionId: string;
  limit: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisDiscoverResponse> {
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
      throw buildApiError("discover", res, detail);
    }

    return (await res.json()) as QverisDiscoverResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function qverisInvoke(params: {
  toolId: string;
  searchId: string;
  sessionId: string;
  parameters: Record<string, unknown>;
  maxResponseSize: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisInvocationResponse> {
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
      throw buildApiError("invoke", res, detail);
    }

    return (await res.json()) as QverisInvocationResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** QVeris get-by-ids API response */
interface QverisGetByIdsResponse {
  tools: QverisDiscoverResultTool[];
}

async function qverisGetByIds(params: {
  toolIds: string[];
  sessionId: string;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisGetByIdsResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const requestBody = {
      tool_ids: params.toolIds,
      session_id: params.sessionId,
    };

    const res = await fetch(`${params.baseUrl}/tools/get-by-ids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw buildApiError("inspect", res, detail);
    }

    return (await res.json()) as QverisGetByIdsResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Session Tool Rolodex — remembers successfully invoked tools for the session
// ============================================================================

interface RolodexEntry {
  toolId: string;
  name: string;
  description: string;
  successCount: number;
  lastUsedAt: number;
  discoveryQuery: string;
  discoveryId?: string;
}

function makeToolRolodex() {
  const store = new Map<string, RolodexEntry>();

  function record(
    toolId: string,
    meta: { name: string; description: string; discoveryQuery: string; discoveryId?: string },
  ) {
    const existing = store.get(toolId);
    if (existing) {
      existing.successCount += 1;
      existing.lastUsedAt = Date.now();
      existing.discoveryId = meta.discoveryId ?? existing.discoveryId;
    } else {
      store.set(toolId, {
        toolId,
        name: meta.name,
        description: meta.description,
        successCount: 1,
        lastUsedAt: Date.now(),
        discoveryQuery: meta.discoveryQuery,
        discoveryId: meta.discoveryId,
      });
    }
  }

  function lookup(toolId: string): RolodexEntry | undefined {
    return store.get(toolId);
  }

  function getSummary(): Array<{
    tool_id: string;
    name: string;
    uses: number;
    discovery_id?: string;
  }> {
    return Array.from(store.values()).map((e) => ({
      tool_id: e.toolId,
      name: e.name,
      uses: e.successCount,
      ...(e.discoveryId ? { discovery_id: e.discoveryId } : {}),
    }));
  }

  return { record, lookup, getSummary };
}

// Track which discovery returned which tool_id so we can populate rolodex on invoke
interface DiscoverResultMeta {
  name: string;
  description: string;
  query: string;
}

function makeDiscoverResultTracker() {
  const store = new Map<string, DiscoverResultMeta>();

  function trackResults(
    query: string,
    tools: Array<{ tool_id: string; name: string; description: string }>,
  ) {
    for (const tool of tools) {
      const existing = store.get(tool.tool_id);
      store.set(tool.tool_id, {
        name: tool.name,
        description: tool.description,
        query: query === "(inspect)" ? (existing?.query ?? query) : query,
      });
    }
  }

  function getMeta(toolId: string): DiscoverResultMeta | undefined {
    return store.get(toolId);
  }

  return { trackResults, getMeta };
}

// ============================================================================
// Tool Schemas
// ============================================================================

const QverisDiscoverSchema = Type.Object({
  query: Type.String({
    description:
      "Capability-oriented discovery query in English. " +
      "This discovers TOOLS (APIs/services), not data — results are tool candidates with metadata. " +
      "GOOD: 'weather forecast API', 'web page content extraction', 'stock price real-time data'. " +
      "BAD: 'what is the weather in Beijing', 'AAPL stock price today', 'ACP protocol documentation'. " +
      "Describe the type of API tool you need, not your end task or question.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (1-100). Default: 10.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

const QverisInvokeSchema = Type.Object({
  tool_id: Type.String({
    description:
      "The ID of the tool to invoke. Must come from a previous qveris_discover or qveris_inspect call.",
  }),
  discovery_id: Type.Optional(
    Type.String({
      description:
        "The discovery_id from qveris_discover or qveris_inspect. " +
        "Required unless this session already knows the discovery_id for the tool_id from a prior discovery/inspect.",
    }),
  ),
  params_to_tool: Type.String({
    description:
      "JSON dictionary of parameters to pass to the tool. " +
      "IMPORTANT: Use sample_parameters from the qveris_discover results as your template. " +
      "Common mistakes to avoid: " +
      '(1) numbers must be unquoted (limit: 10, not "10"); ' +
      "(2) dates must be ISO 8601 (2025-01-15, not 01/15/2025); " +
      '(3) use identifiers not natural language (symbol: "AAPL", not "Apple stock price"); ' +
      "(4) never omit required params listed in the discovery results. " +
      'Example: \'{"city": "London", "units": "metric"}\'.',
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
        "Override timeout in seconds for this invocation. Short tasks (data queries): default 10s. Long tasks (image/video generation, multimodal processing): set 60-120s. Default: 60.",
      minimum: 1,
      maximum: 300,
    }),
  ),
});

const QverisInspectSchema = Type.Object({
  tool_ids: Type.String({
    description:
      "Comma-separated list of QVeris tool IDs to inspect (e.g. 'jina_ai.reader.execute.v1.b2ef8fda,openweathermap.weather.execute.v1'). " +
      "Use tool IDs from a previous qveris_discover or from session context to verify availability and get current parameter schemas.",
  }),
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
    return [];
  }

  const baseUrl = resolveQverisBaseUrl(config);
  const discoverTimeoutSeconds = resolveDiscoverTimeoutSeconds(config);
  const invokeTimeoutSeconds = resolveInvokeTimeoutSeconds(config);
  const maxResponseSize = resolveMaxResponseSize(config);
  const discoverLimit = resolveDiscoverLimit(config);

  const discoverCache = makeDiscoverCache();
  const rolodex = makeToolRolodex();
  const discoverTracker = makeDiscoverResultTracker();

  // Per-tool invoke failure counter for progressive recovery hints
  const invokeFailureCount = new Map<string, number>();

  const sessionId = options?.agentSessionKey ?? `clawdbot-${Date.now()}-${randomUUID()}`;

  function resolveKnownDiscoveryId(toolId: string): string | undefined {
    return rolodex.lookup(toolId)?.discoveryId;
  }

  function formatToolForModel(tool: QverisDiscoverResultTool) {
    const entry = rolodex.lookup(tool.tool_id);
    const discoveryId = resolveKnownDiscoveryId(tool.tool_id);
    return {
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
      ...(discoveryId ? { discovery_id: discoveryId } : {}),
      ...(entry ? { previously_used: true, session_uses: entry.successCount } : {}),
    };
  }

  const discoverTool: AnyAgentTool = {
    label: "QVeris Discover",
    name: "qveris_discover",
    description:
      "Discover third-party API tools by capability type. " +
      "Returns TOOL CANDIDATES with metadata (not data results). " +
      "Use for: real-time data APIs (prices, weather, metrics), external services (image gen, OCR, TTS, translation), and geo/location APIs. " +
      "NOT for: local operations, documentation/tutorials, software configuration, or general web content. " +
      "Describe the TOOL CAPABILITY you need in English (e.g. 'weather forecast API'), not your task goal or question.",
    parameters: QverisDiscoverSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? discoverLimit;
      const normalizedLimit = Math.min(Math.max(1, limit), 100);

      const cacheKey = `${query}:${normalizedLimit}`;
      const cached = discoverCache.read(cacheKey);
      if (cached) {
        return { ...cached, cached: true } as ReturnType<typeof jsonResult>;
      }

      let result: QverisDiscoverResponse;
      try {
        result = await qverisDiscover({
          query,
          sessionId,
          limit: normalizedLimit,
          apiKey,
          baseUrl,
          timeoutSeconds: discoverTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      discoverTracker.trackResults(
        query,
        result.results.map((t) => ({
          tool_id: t.tool_id,
          name: t.name,
          description: t.description,
        })),
      );

      const knownTools = rolodex.getSummary();
      const payload = jsonResult({
        query: result.query,
        total: result.total,
        discovery_id: result.search_id,
        elapsed_time_ms: result.elapsed_time_ms,
        results: result.results.map(formatToolForModel),
        ...(knownTools.length > 0 ? { session_known_tools: knownTools } : {}),
      });

      discoverCache.write(cacheKey, payload, DEFAULT_DISCOVER_CACHE_TTL_MS);
      return payload;
    },
  };

  const invokeTool: AnyAgentTool = {
    label: "QVeris Invoke",
    name: "qveris_invoke",
    description:
      "Invoke a discovered third-party tool with provided parameters. " +
      "tool_id is required; discovery_id should come from qveris_discover or qveris_inspect. " +
      "Pass parameters to the tool through params_to_tool as a JSON string.",
    parameters: QverisInvokeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolId = readStringParam(params, "tool_id", { required: true });
      // Accept discovery_id (new) or search_id (legacy); fall back to session-known IDs.
      const discoveryId =
        readStringParam(params, "discovery_id") ||
        readStringParam(params, "search_id") ||
        resolveKnownDiscoveryId(toolId);
      const paramsToToolRaw = readStringParam(params, "params_to_tool", { required: true });
      const maxSize =
        readNumberParam(params, "max_response_size", { integer: true }) ?? maxResponseSize;
      const timeoutOverride = readNumberParam(params, "timeout_seconds");

      if (!discoveryId) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error",
          detail:
            "Missing discovery_id for qveris_invoke. Run qveris_discover first, or call qveris_inspect for a previously used tool so the session rolodex can provide the discovery_id.",
          retry_hint:
            "Pass discovery_id from qveris_discover/qveris_inspect. If the tool was not previously used in this session, rediscover it to obtain one.",
        } satisfies QverisErrorResult);
      }

      let toolParams: Record<string, unknown>;
      try {
        toolParams = JSON.parse(paramsToToolRaw) as Record<string, unknown>;
      } catch (parseError) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error",
          detail: `Invalid JSON in params_to_tool: ${parseError instanceof Error ? parseError.message : "Unknown parse error"}`,
          retry_hint:
            "Use sample_parameters from the qveris_discover result as a template and ensure valid JSON.",
        } satisfies QverisErrorResult);
      }

      let result: QverisInvocationResponse;
      try {
        result = await qverisInvoke({
          toolId,
          searchId: discoveryId,
          sessionId,
          parameters: toolParams,
          maxResponseSize: maxSize,
          apiKey,
          baseUrl,
          timeoutSeconds: timeoutOverride ?? invokeTimeoutSeconds,
        });
      } catch (err) {
        const failCount = (invokeFailureCount.get(toolId) ?? 0) + 1;
        invokeFailureCount.set(toolId, failCount);
        const recoveryStep =
          failCount === 1 ? "fix_params" : failCount === 2 ? "simplify" : "switch_tool";
        const classified = classifyQverisError(err);
        return jsonResult({
          ...classified,
          recovery_step: recoveryStep,
          attempt_number: failCount,
        });
      }

      if (result.success) {
        invokeFailureCount.delete(toolId);
        const meta = discoverTracker.getMeta(toolId);
        if (meta) {
          rolodex.record(toolId, {
            name: meta.name,
            description: meta.description,
            discoveryQuery: meta.query,
            discoveryId,
          });
        }
      } else {
        // Track failures reported by the QVeris backend (success: false in response body)
        const failCount = (invokeFailureCount.get(toolId) ?? 0) + 1;
        invokeFailureCount.set(toolId, failCount);
        const recoveryStep =
          failCount === 1 ? "fix_params" : failCount === 2 ? "simplify" : "switch_tool";
        return jsonResult({
          execution_id: result.execution_id,
          success: false,
          elapsed_time_ms: result.elapsed_time_ms,
          error_message: result.error_message,
          cost: result.cost ?? result.credits_used,
          recovery_step: recoveryStep,
          attempt_number: failCount,
        });
      }

      const resultData = result.result;
      const isTruncated = Boolean(
        resultData?.truncated_content || resultData?.full_content_file_url,
      );

      return jsonResult({
        execution_id: result.execution_id,
        success: true,
        elapsed_time_ms: result.elapsed_time_ms,
        result: resultData,
        cost: result.cost ?? result.credits_used,
        ...(isTruncated
          ? {
              truncated: true,
              truncation_hint:
                "Response was truncated. Increase max_response_size for full data, " +
                "or use full_content_file_url if available.",
            }
          : {}),
      });
    },
  };

  const inspectTool: AnyAgentTool = {
    label: "QVeris Inspect",
    name: "qveris_inspect",
    description:
      "Inspect known QVeris tools by their IDs without a full discovery. " +
      "Use when you already have a tool_id from a previous qveris_discover or session context and want to verify availability, recover discovery_id when known, and get current parameter schemas. " +
      "Returns tool details including params, sample_parameters, stats, and discovery_id when the session knows it.",
    parameters: QverisInspectSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolIdsRaw = readStringParam(params, "tool_ids", { required: true });
      const toolIds = toolIdsRaw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      if (toolIds.length === 0) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error" as const,
          detail: "No valid tool IDs provided. Pass comma-separated tool IDs.",
          retry_hint: "Example: 'jina_ai.reader.execute.v1.b2ef8fda'",
        } satisfies QverisErrorResult);
      }

      let result: QverisGetByIdsResponse;
      try {
        result = await qverisGetByIds({
          toolIds,
          sessionId,
          apiKey,
          baseUrl,
          timeoutSeconds: discoverTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      discoverTracker.trackResults(
        "(inspect)",
        result.tools.map((t) => ({
          tool_id: t.tool_id,
          name: t.name,
          description: t.description,
        })),
      );

      const tools = result.tools.map(formatToolForModel);
      const resolvedDiscoveryIds = Array.from(
        new Set(
          tools
            .map((tool) => tool.discovery_id)
            .filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      );

      return jsonResult({
        tool_ids_requested: toolIds,
        ...(resolvedDiscoveryIds.length === 1 ? { discovery_id: resolvedDiscoveryIds[0] } : {}),
        tools_found: result.tools.length,
        tools,
        ...(resolvedDiscoveryIds.length === 0
          ? {
              invoke_hint:
                "No discovery_id is known for these tool_ids in this session. If you need to invoke one, run qveris_discover first to obtain a discovery_id.",
            }
          : {}),
      });
    },
  };

  return [discoverTool, invokeTool, inspectTool];
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
