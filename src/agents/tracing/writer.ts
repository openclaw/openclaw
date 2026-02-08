/**
 * Append-only trace writer for recording agent execution.
 *
 * The trace writer is optional and injected at runtime. It records:
 * - LLM calls (prompts, responses, token usage)
 * - Tool executions (name, parameters, results)
 * - State hashes at each step for deterministic verification
 *
 * Design principle: No global state, explicit injection.
 * If disabled, the system behaves exactly as it does today (zero overhead).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { TraceEntry, TraceFile, LLMCallRecord, ToolCallRecord, TokenUsage } from "./schema.js";

/**
 * Shared interface for trace writers (both real and no-op).
 * Allows polymorphic use of TraceWriter and NoOpTraceWriter.
 */
export interface ITraceWriter {
  recordLlmCall(params: {
    messages: unknown;
    response: unknown;
    model: { provider: string; modelId: string; api?: string; thinkingLevel?: string };
    tokenUsage?: TokenUsage;
    stateHash: string;
  }): void;
  recordToolCall(params: {
    toolName: string;
    params: unknown;
    result: { success: boolean; output?: unknown; error?: string };
    stateHash: string;
  }): void;
  recordEnd(params: {
    durationMs?: number;
    outcome: "completed" | "aborted" | "errored";
    error?: string;
  }): void;
  flush(): Promise<void>;
  getTrace(): Readonly<TraceFile> | null;
}

/**
 * Writer that records trace entries to disk.
 * Must be instantiated at the start of a run.
 */
export class TraceWriter implements ITraceWriter {
  private stepIndex = 0;
  private trace: TraceFile;
  private tracePath: string;
  private isInitialized = false;

  constructor(
    tracePath: string,
    sessionId: string,
    sessionKey: string | undefined,
    runId: string,
    initialPrompt: string,
  ) {
    this.tracePath = tracePath;
    this.trace = {
      traceVersion: 1,
      metadata: {
        createdAt: Date.now(),
        sessionId,
        sessionKey,
        runId,
        initialPrompt,
        durationMs: 0,
        outcome: "completed",
      },
      entries: [],
    };
  }

  /**
   * Initialize the trace file on disk.
   * Should be called once before recording any entries.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    // Create directory if needed
    await fs.mkdir(path.dirname(this.tracePath), { recursive: true });
    // Write initial trace (empty entries)
    await this.flush();
    this.isInitialized = true;
  }

  /**
   * Record an LLM call to the trace.
   * Note: callers must call flush() to persist entries to disk.
   */
  recordLlmCall(params: {
    messages: unknown;
    response: unknown;
    model: { provider: string; modelId: string; api?: string; thinkingLevel?: string };
    tokenUsage?: TokenUsage;
    stateHash: string;
  }): void {
    const entry: LLMCallRecord = {
      type: "llm_call",
      stepIndex: this.stepIndex++,
      timestamp: Date.now(),
      model: params.model,
      messages: params.messages,
      response: params.response,
      tokenUsage: params.tokenUsage,
      stateHash: params.stateHash,
    };
    this.trace.entries.push(entry);
  }

  /**
   * Record a tool call to the trace.
   * Note: callers must call flush() to persist entries to disk.
   */
  recordToolCall(params: {
    toolName: string;
    params: unknown;
    result: { success: boolean; output?: unknown; error?: string };
    stateHash: string;
  }): void {
    const entry: ToolCallRecord = {
      type: "tool_call",
      stepIndex: this.stepIndex++,
      timestamp: Date.now(),
      toolName: params.toolName,
      params: params.params,
      result: params.result,
      stateHash: params.stateHash,
    };
    this.trace.entries.push(entry);
  }

  /**
   * Mark the run as ended with final metadata.
   */
  recordEnd(params: {
    durationMs?: number;
    outcome: "completed" | "aborted" | "errored";
    error?: string;
  }): void {
    if (typeof params.durationMs === "number") {
      this.trace.metadata.durationMs = params.durationMs;
    }
    this.trace.metadata.outcome = params.outcome;
    this.trace.metadata.error = params.error;
  }

  /**
   * Flush the current trace to disk.
   * Called automatically after each entry in append-only mode.
   */
  async flush(): Promise<void> {
    const json = JSON.stringify(this.trace, null, 2);
    await fs.writeFile(this.tracePath, json, "utf-8");
  }

  /**
   * Get the trace for inspection (e.g., testing).
   */
  getTrace(): Readonly<TraceFile> {
    return this.trace;
  }
}

/**
 * Factory function to conditionally create a trace writer.
 * Returns null if tracing is disabled.
 */
export async function createTraceWriterIfEnabled(params: {
  tracePath?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  initialPrompt: string;
}): Promise<TraceWriter | null> {
  if (!params.tracePath) {
    return null;
  }

  const writer = new TraceWriter(
    params.tracePath,
    params.sessionId,
    params.sessionKey,
    params.runId,
    params.initialPrompt,
  );

  await writer.initialize();
  return writer;
}

/**
 * No-op trace writer for when tracing is disabled.
 * Implements the same interface but does nothing.
 */
export class NoOpTraceWriter implements ITraceWriter {
  recordLlmCall(params: {
    messages: unknown;
    response: unknown;
    model: { provider: string; modelId: string; api?: string; thinkingLevel?: string };
    tokenUsage?: TokenUsage;
    stateHash: string;
  }): void {
    // no-op
  }

  recordToolCall(params: {
    toolName: string;
    params: unknown;
    result: { success: boolean; output?: unknown; error?: string };
    stateHash: string;
  }): void {
    // no-op
  }

  recordEnd(params: {
    durationMs?: number;
    outcome: "completed" | "aborted" | "errored";
    error?: string;
  }): void {
    // no-op
  }

  async flush(): Promise<void> {
    // no-op
  }

  getTrace(): Readonly<TraceFile> | null {
    // Return null for no-op writer since no trace is recorded
    return null;
  }
}
