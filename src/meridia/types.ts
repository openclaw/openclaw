import type { OpenClawConfig } from "../config/config.js";

export type MeridiaEvaluation = {
  kind: "heuristic" | "llm";
  score: number;
  recommendation: "capture" | "skip";
  reason?: string;
  model?: string;
  durationMs?: number;
};

export type MeridiaToolResultContext = {
  cfg?: OpenClawConfig;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolName: string;
  toolCallId: string;
  meta?: string;
  isError: boolean;
  args?: unknown;
  result?: unknown;
};

export type MeridiaExperienceRecord = {
  id: string;
  ts: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  tool: {
    name: string;
    callId: string;
    meta?: string;
    isError: boolean;
  };
  data: {
    args?: unknown;
    result?: unknown;
  };
  evaluation: MeridiaEvaluation;
};

export type MeridiaBuffer = {
  version: 1;
  sessionId?: string;
  sessionKey?: string;
  createdAt: string;
  updatedAt: string;
  toolResultsSeen: number;
  captured: number;
  lastSeenAt?: string;
  lastCapturedAt?: string;
  recentCaptures: Array<{ ts: string; toolName: string; score: number; recordId: string }>;
  recentEvaluations: Array<{
    ts: string;
    toolName: string;
    score: number;
    recommendation: "capture" | "skip";
    reason?: string;
  }>;
  lastError?: { ts: string; toolName: string; message: string };
};

export type MeridiaTraceEvent =
  | {
      type: "tool_result";
      ts: string;
      sessionId?: string;
      sessionKey?: string;
      runId?: string;
      toolName: string;
      toolCallId: string;
      meta?: string;
      isError: boolean;
      decision: "capture" | "skip" | "error";
      score?: number;
      threshold?: number;
      limited?: { reason: "min_interval" | "max_per_hour"; detail?: string };
      eval?: Omit<MeridiaEvaluation, "recommendation">;
      recordId?: string;
      error?: string;
    }
  | {
      type: "precompact";
      ts: string;
      sessionId?: string;
      sessionKey?: string;
      runId?: string;
      assistantTextCount?: number;
      toolMetaCount?: number;
      note?: string;
    }
  | {
      type: "compaction_end";
      ts: string;
      sessionId?: string;
      sessionKey?: string;
      runId?: string;
      willRetry?: boolean;
    }
  | {
      type: "session_end";
      ts: string;
      action: "new" | "stop";
      sessionId?: string;
      sessionKey?: string;
      summaryPath?: string;
    };
