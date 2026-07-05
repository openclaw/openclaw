// Shared status output types.
// These shapes are consumed by scan, summary, text report, and JSON status builders.

import type { ChannelId } from "../channels/plugins/types.public.js";
import type { SessionKind } from "../sessions/classify-session-kind.js";
<<<<<<< HEAD
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type {
  RetainedLostTaskAuditSummary,
  TaskAuditSummary,
} from "../tasks/task-registry.audit.js";
import type { TaskRegistrySummary } from "../tasks/task-registry.types.js";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: SessionKind;
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
<<<<<<< HEAD
  fastMode?: FastMode;
=======
  fastMode?: boolean;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
};

/** Aggregate status summary before text or JSON formatting. */
export type StatusSummary = {
  runtimeVersion?: string | null;
  eventLoop?: import("../gateway/server/event-loop-health.js").GatewayEventLoopHealth;
  linkChannel?: {
    id: ChannelId;
    label: string;
    linked: boolean;
    authAgeMs: number | null;
  };
  heartbeat: {
    defaultAgentId: string;
    agents: HeartbeatStatus[];
  };
  channelSummary: string[];
  queuedSystemEvents: string[];
  tasks: TaskRegistrySummary;
  taskAudit: TaskAuditSummary;
  taskAuditRetainedLost?: RetainedLostTaskAuditSummary;
  sessions: {
    paths: string[];
    count: number;
    defaults: { model: string | null; contextTokens: number | null };
    recent: SessionStatus[];
    byAgent: Array<{
      agentId: string;
      path: string;
      count: number;
      recent: SessionStatus[];
    }>;
  };
};
