// Shared status output types.
// These shapes are consumed by scan, summary, text report, and JSON status builders.

import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionKind } from "../sessions/classify-session-kind.js";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: SessionKind;
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
  fastMode?: FastMode;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number | null;
  totalTokensFresh: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  remainingTokens: number | null;
  percentUsed: number | null;
  model: string | null;
  configuredModel: string | null;
  selectedModel: string | null;
  modelSelectionReason: string | null;
  runtime?: string | null;
  contextTokens: number | null;
  flags: string[];
};

/** Heartbeat schedule state for one agent. */
export type HeartbeatStatus = {
  agentId: string;
  enabled: boolean;
  every: string;
  everyMs: number | null;
  waitingForRoute?: boolean;
};
