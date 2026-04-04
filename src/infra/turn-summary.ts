import type { CacheTraceEvent } from "../agents/cache-trace.js";
import type { NormalizedUsage } from "../agents/usage.js";

export type TurnToolCall = {
  name: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  success: boolean;
  error?: string;
};

export type TurnSummary = {
  turnId: string;
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  iterations: number;
  toolCalls: TurnToolCall[];
  usage?: NormalizedUsage;
  cacheEvents: CacheTraceEvent[];
  outcome: "success" | "error" | "aborted" | "compaction";
  error?: string;
};

/**
 * Mutable builder for accumulating turn data during execution.
 * Call `freeze()` to get the final immutable TurnSummary.
 */
export class TurnSummaryBuilder {
  private summary: TurnSummary;
  private activeTools = new Map<string, TurnToolCall>();

  constructor(params: {
    turnId: string;
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    provider?: string;
    model?: string;
  }) {
    this.summary = {
      turnId: params.turnId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      startedAt: Date.now(),
      iterations: 0,
      toolCalls: [],
      cacheEvents: [],
      outcome: "success",
    };
  }

  incrementIterations(): void {
    this.summary.iterations += 1;
  }

  recordToolStart(callId: string, name: string): void {
    const entry: TurnToolCall = { name, startedAt: Date.now(), success: true };
    this.activeTools.set(callId, entry);
    this.summary.toolCalls.push(entry);
  }

  recordToolEnd(callId: string, success: boolean, error?: string): void {
    const entry = this.activeTools.get(callId);
    if (!entry) {
      return;
    }
    entry.completedAt = Date.now();
    entry.durationMs = entry.completedAt - entry.startedAt;
    entry.success = success;
    if (error) {
      entry.error = error;
    }
    this.activeTools.delete(callId);
  }

  setUsage(usage: NormalizedUsage): void {
    this.summary.usage = usage;
  }

  addCacheEvent(event: CacheTraceEvent): void {
    this.summary.cacheEvents.push(event);
  }

  setOutcome(outcome: TurnSummary["outcome"], error?: string): void {
    this.summary.outcome = outcome;
    if (error) {
      this.summary.error = error;
    }
  }

  freeze(): TurnSummary {
    const now = Date.now();
    this.summary.completedAt = now;
    this.summary.durationMs = now - this.summary.startedAt;
    return {
      ...this.summary,
      toolCalls: [...this.summary.toolCalls],
      cacheEvents: [...this.summary.cacheEvents],
    };
  }
}
