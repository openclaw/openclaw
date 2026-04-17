import type { ChannelId } from "../channels/plugins/types.public.js";
import type { TaskAuditSummary } from "../tasks/task-registry.audit.js";
import type { TaskRegistrySummary } from "../tasks/task-registry.types.js";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
  fastMode?: boolean;
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
  contextTokens: number | null;
  flags: string[];
};

export type HeartbeatStatus = {
  agentId: string;
  enabled: boolean;
  every: string;
  everyMs: number | null;
};

export type StatusContributorSummary = {
  id: string;
  label: string;
  state: "ok" | "warn" | "error" | "info";
  summary: string;
  details?: string[];
};

export type A2AHealthState = "ok" | "delayed" | "waiting_external" | "failed" | "config_error";

export type A2ALatestFailedTaskSummary = {
  agentId: string;
  sessionKey: string;
  taskId: string;
  executionStatus: string;
  deliveryStatus: string;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
  summary?: string;
};

export type A2AStatusSummary = {
  state: A2AHealthState;
  tasks: {
    total: number;
    active: number;
    failed: number;
    waitingExternal: number;
    delayed: number;
    latestFailed: A2ALatestFailedTaskSummary | null;
  };
  issues: {
    brokerUnreachable: number;
    reconcileFailed: number;
    deliveryFailed: number;
    cancelNotAttempted: number;
    sessionAbortFailed: number;
  };
  broker: {
    pluginEnabled: boolean;
    adapterEnabled: boolean;
    baseUrlPresent: boolean;
    edgeSecretPresent: boolean;
    methodScopesOk: boolean;
  };
};

export type StatusSummary = {
  runtimeVersion?: string | null;
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
  contributors?: StatusContributorSummary[];
  a2a: A2AStatusSummary;
  tasks: TaskRegistrySummary;
  taskAudit: TaskAuditSummary;
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
