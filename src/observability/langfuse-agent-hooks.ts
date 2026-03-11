/**
 * Langfuse agent instrumentation hooks for OpenClaw.
 *
 * Provides helpers for:
 *  - Model generation spans
 *  - Tool-call spans (via full-fidelity global agent event stream)
 *  - Subagent-spawn spans
 *  - Payload redaction and truncation
 *
 * All functions are safe no-ops when called outside an active Langfuse
 * request scope (i.e. when Langfuse is disabled or not configured).
 *
 * ## Tool span bookkeeping
 * Tool spans are opened when a tool.start event fires and closed on tool.result.
 * The agent runner must call clearRunToolSpans(runId) in its finally block to
 * guarantee cleanup even when the run throws before tool.result fires.
 */

import { onAgentEvent } from "../infra/agent-events.js";
import { getLangfuseRequestScope } from "./langfuse-request-scope.js";
import type { LangfuseHandle } from "./langfuse.js";

// ─────────────────────────────────────────────────────────────────────────────
// Payload redaction and safety
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_KEY_RE =
  /^(token|secret|password|authorization|apikey|api_key|auth|credential|private_key|access_token|refresh_token|bearer)$/i;

const MAX_STRING_LEN = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJ_DEPTH = 5;
const MAX_DEPTH_EXCEEDED = "[max depth exceeded]";
const UNKNOWN_TOOL_ERROR = "unknown tool error";
const UNSERIALIZABLE_TOOL_ERROR = "[unserializable tool error]";

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_OBJ_DEPTH) {
    return MAX_DEPTH_EXCEEDED;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LEN ? `${value.slice(0, MAX_STRING_LEN)}…[truncated]` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…[${value.length - MAX_ARRAY_ITEMS} more items]`]
      : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[REDACTED]" : redactValue(v, depth + 1);
  }
  return out;
}

/** Recursively redact known sensitive keys and truncate oversized strings. */
export function redactPayload(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return redactValue(value, 0);
  } catch {
    return "[could not process payload]";
  }
}

/** Truncate a string to at most `maxLen` characters, appending an ellipsis marker. */
export function truncateString(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen)}…[truncated]`;
}

function formatToolError(result: unknown): string {
  if (typeof result === "string") {
    return truncateString(result, 500);
  }
  try {
    return truncateString(JSON.stringify(redactPayload(result ?? UNKNOWN_TOOL_ERROR)), 500);
  } catch {
    return UNSERIALIZABLE_TOOL_ERROR;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model generation tracking
// ─────────────────────────────────────────────────────────────────────────────

/** Start a Langfuse generation child span from the current request scope. Returns null when Langfuse is not active. */
export function startModelGeneration(params: {
  provider: string;
  model: string;
  prompt: string;
}): LangfuseHandle | null {
  const scope = getLangfuseRequestScope();
  if (!scope || !scope.trace.enabled) {
    return null;
  }
  return scope.trace.generation({
    name: "model.generation",
    model: `${params.provider}/${params.model}`,
    input: truncateString(params.prompt, 4_000),
    metadata: { provider: params.provider, model: params.model },
  });
}

/** Close a model generation handle with success data. No-op if handle is null. */
export function endModelGeneration(
  handle: LangfuseHandle | null,
  params: {
    outputText?: string;
    provider: string;
    model: string;
    durationMs: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    fallbackAttemptCount?: number;
  },
): void {
  if (!handle) {
    return;
  }
  handle.end({
    output: params.outputText ? truncateString(params.outputText, 4_000) : undefined,
    model: `${params.provider}/${params.model}`,
    usage: params.usage
      ? {
          input: params.usage.input ?? 0,
          output: params.usage.output ?? 0,
          total: params.usage.total,
        }
      : undefined,
    metadata: {
      provider: params.provider,
      model: params.model,
      durationMs: params.durationMs,
      fallbackAttemptCount: params.fallbackAttemptCount ?? 0,
    },
  });
}

/** Capture an error on a model generation handle. No-op if handle is null. */
export function errorModelGeneration(handle: LangfuseHandle | null, error: unknown): void {
  if (!handle) {
    return;
  }
  handle.captureError(error, { phase: "model.generation" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool span tracking (via full-fidelity global agent event stream)
// ─────────────────────────────────────────────────────────────────────────────

type ToolSpanRecord = {
  handle: LangfuseHandle;
  startedAt: number;
  name: string;
};

/**
 * Per-runId map of currently-open tool spans.
 * Keyed outer: runId; inner: toolCallId.
 * Must be cleaned up via clearRunToolSpans() in the agent runner's finally block.
 */
const openToolSpansByRun = new Map<string, Map<string, ToolSpanRecord>>();

function getRunToolSpanMap(runId: string): Map<string, ToolSpanRecord> {
  let map = openToolSpansByRun.get(runId);
  if (!map) {
    map = new Map();
    openToolSpansByRun.set(runId, map);
  }
  return map;
}

let agentEventListenerRegistered = false;

/**
 * Register the global agent event listener for tool span tracking.
 * Idempotent — safe to call multiple times.
 *
 * Uses the full-fidelity emitAgentEvent stream (not the stripped UI-callback
 * path passed to pi-embedded), so args and result are always present.
 */
export function initializeLangfuseAgentHooks(): void {
  if (agentEventListenerRegistered) {
    return;
  }
  agentEventListenerRegistered = true;
  onAgentEvent((evt) => {
    if (evt.stream !== "tool") {
      return;
    }
    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    const runId = evt.runId;
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : "";
    const toolName = typeof evt.data.name === "string" ? evt.data.name : "unknown";

    if (phase === "start") {
      // Open a span for this tool call. Uses AsyncLocalStorage context from
      // the agent runner, which runs inside withLangfuseRequestScope().
      const scope = getLangfuseRequestScope();
      if (!scope || !scope.trace.enabled) {
        return;
      }
      const args = evt.data.args;
      const handle = scope.trace.span({
        name: `tool.${toolName}`,
        input: redactPayload(args),
        metadata: { toolCallId, runId, toolName },
      });
      getRunToolSpanMap(runId).set(toolCallId, {
        handle,
        startedAt: Date.now(),
        name: toolName,
      });
    } else if (phase === "result") {
      // Close the span opened at "start".
      const spans = openToolSpansByRun.get(runId);
      if (!spans) {
        return;
      }
      const record = spans.get(toolCallId);
      if (!record) {
        return;
      }
      const durationMs = Date.now() - record.startedAt;
      const isError = evt.data.isError === true;
      const result = evt.data.result;
      if (isError) {
        record.handle.captureError(formatToolError(result), { toolCallId, runId, durationMs });
      } else {
        record.handle.end({
          output: redactPayload(result),
          metadata: { toolCallId, durationMs },
        });
      }
      spans.delete(toolCallId);
      if (spans.size === 0) {
        openToolSpansByRun.delete(runId);
      }
    }
  });
}

/**
 * Close and discard all open tool spans for a given run.
 * Must be called in the finally block of the agent runner to prevent orphan spans
 * when the run throws before all tool.result events fire.
 */
export function clearRunToolSpans(runId: string): void {
  const spans = openToolSpansByRun.get(runId);
  if (!spans) {
    return;
  }
  for (const record of spans.values()) {
    record.handle.end({ statusMessage: "run ended before tool completed" });
  }
  spans.clear();
  openToolSpansByRun.delete(runId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subagent span tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a subagent-spawn span under the current request scope.
 * Returns null when Langfuse is not active.
 */
export function startSubagentSpan(params: {
  agentId?: string;
  task: string;
  model?: string;
}): LangfuseHandle | null {
  const scope = getLangfuseRequestScope();
  if (!scope) {
    return null;
  }
  return scope.trace.span({
    name: "subagent.spawn",
    input: truncateString(params.task, 2_000),
    metadata: { agentId: params.agentId, model: params.model },
  });
}

/**
 * End a subagent span with the spawn result.
 * Captures an error span when the spawn failed or was forbidden.
 */
export function endSubagentSpan(
  handle: LangfuseHandle | null,
  result: {
    status: string;
    childSessionKey?: string;
    runId?: string;
    error?: string;
  },
): void {
  if (!handle) {
    return;
  }
  if (result.status === "error" || result.status === "forbidden") {
    handle.captureError(result.error ?? `subagent spawn ${result.status}`, {
      childSessionKey: result.childSessionKey,
      status: result.status,
    });
  } else {
    handle.end({
      output: result.status,
      metadata: {
        childSessionKey: result.childSessionKey,
        runId: result.runId,
        status: result.status,
      },
    });
  }
}
