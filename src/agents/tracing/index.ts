/**
 * Deterministic tracing for agent runs.
 *
 * This module provides infrastructure for recording agent execution,
 * enabling reproducible debugging and regression testing.
 *
 * Main components:
 * - schema: Versioned trace data structures
 * - state-hash: Deterministic SHA-256 hashing of agent state
 * - writer: Append-only trace recording (optional)
 */

export type {
  TraceEntry,
  TraceFile,
  LLMCallRecord,
  ToolCallRecord,
  TokenUsage,
  ModelConfig,
} from "./schema.js";
export { loadTrace, serializeTrace } from "./schema.js";

export { hashAgentState, hashAndDescribe } from "./state-hash.js";

export { TraceWriter, NoOpTraceWriter, createTraceWriterIfEnabled } from "./writer.js";
