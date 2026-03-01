/**
 * xAI/Grok native tool integrations.
 *
 * Exposes two xAI Responses API built-in tools:
 *   - xai_search  — searches X (Twitter) posts via xAI's native x_search tool
 *   - xai_code_exec — executes Python code in xAI's remote sandbox
 *
 * These are server-side tools that run on xAI's infrastructure and return
 * LLM-synthesized summaries, distinct from the general web_search tool.
 *
 * Config:
 *   XAI_API_KEY env var, or tools.xai.apiKey in gateway config.
 *   tools.xai.model  — model (default: "grok-4")
 *   tools.xai.search.enabled   — enable x_search (default: true when key present)
 *   tools.xai.codeExec.enabled — enable code_exec_python (default: true when key present)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
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

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_XAI_MODEL = "grok-4";

// Shared response structure for xAI Responses API
type XaiResponsesOutput = Array<{
  type?: string;
  role?: string;
  stdout?: string;
  stderr?: string;
  return_code?: number;
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
}>;

type XaiResponsesBody = {
  output?: XaiResponsesOutput;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

// Caches keyed by feature
const X_SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const CODE_EXEC_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

/** Short TTL (minutes) for time-sensitive X search so cache is not used for fresh queries. */
const X_SEARCH_CACHE_TTL_TIME_SENSITIVE_MINUTES = 2;

// ============================================================================
// Config helpers
// ============================================================================

type XaiToolsRawConfig = {
  apiKey?: string;
  model?: string;
  search?: { enabled?: boolean };
  codeExec?: { enabled?: boolean };
};

function resolveXaiRawConfig(config?: OpenClawConfig): XaiToolsRawConfig {
  const tools = (config as Record<string, unknown> | undefined)?.tools;
  if (!tools || typeof tools !== "object") {
    return {};
  }
  const xai = (tools as Record<string, unknown>).xai;
  if (!xai || typeof xai !== "object") {
    return {};
  }
  return xai as XaiToolsRawConfig;
}

function resolveXaiApiKey(raw: XaiToolsRawConfig): string | undefined {
  const fromConfig = normalizeSecretInput(raw.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  return normalizeSecretInput(process.env.XAI_API_KEY) || undefined;
}

function resolveXaiModel(raw: XaiToolsRawConfig): string {
  const fromConfig = raw.model && typeof raw.model === "string" ? raw.model.trim() : "";
  return fromConfig || DEFAULT_XAI_MODEL;
}

// ============================================================================
// Shared API helpers
// ============================================================================

/**
 * Extract the primary text from an xAI Responses API output block.
 */
function extractXaiText(output: XaiResponsesOutput): {
  text: string | undefined;
  citations: string[];
} {
  for (const block of output) {
    if (block.type === "message") {
      for (const part of block.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string" && part.text) {
          const citations = (part.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: part.text, citations: [...new Set(citations)] };
        }
      }
    }
  }
  return { text: undefined, citations: [] };
}

/**
 * Extract Python code execution result from the Responses API output.
 */
function extractCodeExecResult(output: XaiResponsesOutput): {
  stdout: string;
  stderr: string;
  returnCode: number;
  summary: string | undefined;
} {
  let stdout = "";
  let stderr = "";
  let returnCode: number | null = null;
  let summary: string | undefined;

  for (const block of output) {
    if (block.type === "code_exec_result") {
      stdout = block.stdout ?? "";
      stderr = block.stderr ?? "";
      returnCode = block.return_code ?? 0;
    }
    if (block.type === "message") {
      for (const part of block.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          summary = part.text;
        }
      }
    }
  }

  if (returnCode === null) {
    returnCode = 1;
    stderr = (stderr ? `${stderr}\n` : "") + "Missing code_exec_result in API response.";
  }

  return { stdout, stderr, returnCode, summary };
}

async function callXaiResponsesApi(params: {
  apiKey: string;
  model: string;
  prompt: string;
  toolType: string;
  toolOptions?: Record<string, unknown>;
  timeoutSeconds: number;
}): Promise<XaiResponsesBody> {
  const tool: Record<string, unknown> = { type: params.toolType };
  if (params.toolOptions) {
    Object.assign(tool, params.toolOptions);
  }

  const body = {
    model: params.model,
    input: [{ role: "user", content: params.prompt }],
    tools: [tool],
  };

  const res = await fetch(XAI_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 16_000 });
    throw new Error(`xAI Responses API error (${res.status}): ${detail.text || res.statusText}`);
  }

  return (await res.json()) as XaiResponsesBody;
}

// ============================================================================
// xai_search — X/Twitter search via xAI native x_search
// ============================================================================

const XaiSearchSchema = Type.Object({
  query: Type.String({ description: "Search query for X (Twitter) posts." }),
  count: Type.Optional(
    Type.Number({
      description: "Approximate number of relevant posts to surface (1-20, default: 10).",
      minimum: 1,
      maximum: 20,
    }),
  ),
  timeSensitive: Type.Optional(
    Type.Boolean({
      description:
        "If true, skip cache and request fresh results (e.g. breaking news). Uses short cache TTL when storing.",
    }),
  ),
});

/**
 * Create the xai_search tool.
 *
 * Uses xAI's native x_search capability to find and summarize X/Twitter posts.
 * Returns an AI-synthesized answer with source URLs from X.
 */
export function createXaiSearchTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const raw = resolveXaiRawConfig(options?.config);
  const apiKey = resolveXaiApiKey(raw);

  // Don't register the tool if no API key is configured
  if (!apiKey) {
    return null;
  }

  // Respect explicit disable
  if (raw.search?.enabled === false) {
    return null;
  }

  const model = resolveXaiModel(raw);

  return {
    label: "X Search",
    name: "xai_search",
    description:
      "Search X (Twitter) posts using xAI Grok's native x_search. " +
      "Returns AI-synthesized summaries of X posts matching the query, " +
      "with citations linking to the original posts. " +
      "Use this for trending topics, public opinions, breaking news on X, or finding specific X posts.",
    parameters: XaiSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count = typeof params.count === "number" ? Math.min(20, Math.max(1, params.count)) : 10;
      const isTimeSensitive = typeof params.timeSensitive === "boolean" && params.timeSensitive;

      const cacheKey = normalizeCacheKey(`xai_search:${model}:${query}:${count}`);
      if (!isTimeSensitive) {
        const cached = readCache(X_SEARCH_CACHE, cacheKey);
        if (cached) {
          return jsonResult({ ...cached.value, cached: true });
        }
      }

      const start = Date.now();

      // Build a focused prompt so Grok returns the right number of posts
      const prompt =
        count !== 10
          ? `Find approximately ${count} relevant X posts about: ${query}`
          : `Search X for: ${query}`;

      const data = await callXaiResponsesApi({
        apiKey,
        model,
        prompt,
        toolType: "x_search",
        timeoutSeconds: resolveTimeoutSeconds(undefined, DEFAULT_TIMEOUT_SECONDS),
      });

      const { text, citations } = extractXaiText(data.output ?? []);
      const topLevelCitations = (data.citations ?? []).length > 0 ? data.citations! : citations;

      const payload = {
        query,
        provider: "xai",
        tool: "x_search",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "xai_search",
          provider: "xai",
          wrapped: true,
        },
        content: text ? wrapWebContent(text, "web_search") : "",
        citations: topLevelCitations,
      };

      const ttlMinutes = isTimeSensitive
        ? X_SEARCH_CACHE_TTL_TIME_SENSITIVE_MINUTES
        : DEFAULT_CACHE_TTL_MINUTES;
      writeCache(X_SEARCH_CACHE, cacheKey, payload, resolveCacheTtlMs(undefined, ttlMinutes));
      return jsonResult(payload);
    },
  };
}

// ============================================================================
// xai_code_exec — Python sandbox via xAI native code_exec_python
// ============================================================================

const XaiCodeExecSchema = Type.Object({
  task: Type.String({
    description:
      "Describe the Python task to perform. Grok will write and execute Python code on its sandbox. " +
      "Example: 'Calculate compound interest for $10,000 at 5% over 10 years' or " +
      "'Parse this JSON and extract all email addresses: {json_data}'.",
  }),
  hint: Type.Optional(
    Type.String({
      description: "Optional hint or code snippet to guide the execution.",
    }),
  ),
});

/**
 * Create the xai_code_exec tool.
 *
 * Uses xAI's native code_exec_python capability to execute Python code
 * in xAI's remote sandbox environment. Grok writes the code, executes it,
 * and returns both the output and an AI-synthesized explanation.
 */
export function createXaiCodeExecTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const raw = resolveXaiRawConfig(options?.config);
  const apiKey = resolveXaiApiKey(raw);

  if (!apiKey) {
    return null;
  }
  if (raw.codeExec?.enabled === false) {
    return null;
  }

  const model = resolveXaiModel(raw);

  return {
    label: "xAI Code Exec",
    name: "xai_code_exec",
    description:
      "Execute Python code using xAI Grok's native remote sandbox (code_exec_python). " +
      "Grok writes Python code for the given task, runs it in xAI's secure sandbox, " +
      "and returns the stdout, stderr, exit code, and an AI-synthesized explanation. " +
      "Best for: data processing, calculations, text parsing, JSON manipulation, " +
      "algorithmic tasks, and any computation that benefits from code execution.",
    parameters: XaiCodeExecSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const hint = readStringParam(params, "hint");

      const cacheKey = normalizeCacheKey(`xai_code_exec:${model}:${task}:${hint ?? ""}`);
      const cached = readCache(CODE_EXEC_CACHE, cacheKey);
      if (cached) {
        return jsonResult({ ...cached.value, cached: true });
      }

      const start = Date.now();

      const prompt = hint ? `${task}\n\nHint: ${hint}` : task;

      const data = await callXaiResponsesApi({
        apiKey,
        model,
        prompt,
        toolType: "code_exec_python",
        timeoutSeconds: resolveTimeoutSeconds(undefined, DEFAULT_TIMEOUT_SECONDS * 3), // code exec can take longer
      });

      const output = data.output ?? [];
      const { stdout, stderr, returnCode, summary } = extractCodeExecResult(output);

      const payload = {
        task,
        provider: "xai",
        tool: "code_exec_python",
        model,
        tookMs: Date.now() - start,
        returnCode,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        summary: summary || undefined,
        success: returnCode === 0,
      };

      // Cache successful results only (non-deterministic tasks may vary)
      if (returnCode === 0) {
        writeCache(
          CODE_EXEC_CACHE,
          cacheKey,
          payload,
          resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
        );
      }

      return jsonResult(payload);
    },
  };
}
