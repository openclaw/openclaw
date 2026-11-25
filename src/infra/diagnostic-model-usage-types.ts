import type { IsolatedCompletionPurpose } from "../agents/isolated-completion-purpose.js";

export type DiagnosticModelUsageFields = {
  type: "model.usage";
  channel?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  purpose?: IsolatedCompletionPurpose;
  runtimeKind?: "cli" | "harness";
  /** Isolated runtime dispatch identity, not a provider request or billing receipt. */
  completionId?: string;
  attemptId?: string;
  usageReport?: { state: "available" | "unavailable" };
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};
