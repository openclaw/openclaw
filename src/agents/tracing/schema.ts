/**
 * Deterministic trace schema for agent runs.
 *
 * This module defines the versioned trace format used for recording agent execution.
 * Traces are append-only, serializable to JSON, and designed to capture the exact execution
 * state without any runtime side effects (no random UUIDs, timestamps are minimal).
 *
 * Design principle: Record the essential execution details for inspection and analysis.
 */

/**
 * Token usage information from an LLM call.
 * Varies by provider (Claude reports input + output + cache tokens, OpenAI reports similar).
 * Optional because some models or fallback paths may not report tokens.
 */
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

/**
 * LLM model configuration and metadata.
 */
export type ModelConfig = {
  provider: string;
  modelId: string;
  /** Model API alias (e.g. "bedrock", "standard") */
  api?: string;
  /** Thinking level if applicable (off | minimal | low | medium | high | xhigh) */
  thinkingLevel?: string;
};

/**
 * Single LLM call: prompt in, response out.
 * Captures the exact messages sent and the raw LLM response.
 */
export type LLMCallRecord = {
  type: "llm_call";
  /** Monotonic step index */
  stepIndex: number;
  timestamp: number;
  model: ModelConfig;
  /** Messages exactly as sent to the LLM */
  messages: unknown;
  /** Raw LLM response (text or structured output) */
  response: unknown;
  tokenUsage?: TokenUsage;
  /** Stable hash of agent state after this step */
  stateHash: string;
};

/**
 * Single tool execution: tool name + args in, result out.
 */
export type ToolCallRecord = {
  type: "tool_call";
  stepIndex: number;
  timestamp: number;
  toolName: string;
  /** Serialized tool parameters */
  params: unknown;
  /** Raw tool result or error */
  result: {
    success: boolean;
    /** Result data if successful */
    output?: unknown;
    /** Error message if failed */
    error?: string;
  };
  /** Stable hash of agent state after this step */
  stateHash: string;
};

export type TraceEntry = LLMCallRecord | ToolCallRecord;

/**
 * Complete trace of one agent run.
 * Versioned for forward/backward compatibility.
 */
export type TraceFile = {
  /** Schema version for compatibility checks */
  traceVersion: 1;
  /** High-level metadata about the run */
  metadata: {
    /** When the trace was created */
    createdAt: number;
    /** Session ID (e.g. "main:telegram:+1234567890") */
    sessionId: string;
    /** Session key for context routing */
    sessionKey?: string;
    /** Unique run ID */
    runId: string;
    /** Initial prompt to the agent */
    initialPrompt: string;
    /** Total duration in milliseconds */
    durationMs: number;
    /** Outcome summary (completed | aborted | errored) */
    outcome: "completed" | "aborted" | "errored";
    /** Optional error message if outcome is errored */
    error?: string;
  };
  /** Ordered sequence of steps (LLM calls and tool calls) */
  entries: TraceEntry[];
};

/**
 * Load a trace from JSON.
 * Validates that it matches the schema version and has required structure.
 */
export function loadTrace(json: string): TraceFile {
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("traceVersion" in parsed) ||
    (parsed as Record<string, unknown>).traceVersion !== 1
  ) {
    throw new Error("Invalid trace: missing or unsupported traceVersion");
  }

  // Validate that metadata and entries exist and have correct structure
  const parsedObj = parsed as Record<string, unknown>;
  if (typeof parsedObj.metadata !== "object" || parsedObj.metadata === null) {
    throw new Error("Invalid trace: missing metadata or entries");
  }
  if (!Array.isArray(parsedObj.entries)) {
    throw new Error("Invalid trace: missing metadata or entries");
  }

  return parsed as TraceFile;
}

/**
 * Serialize a trace to JSON for storage.
 */
export function serializeTrace(trace: TraceFile): string {
  return JSON.stringify(trace, null, 2);
}
