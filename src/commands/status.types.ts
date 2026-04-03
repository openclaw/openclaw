import type { ChannelId } from "../channels/plugins/types.js";
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
    diagnostics?: {
      latency?: {
        dominant?: Array<{
          segment:
            | "dispatchToQueue"
            | "queueToRun"
            | "acpEnsureToRun"
            | "runToFirstEvent"
            | "firstEventToFirstVisible"
            | "runToFirstVisible"
            | "firstVisibleToFinal"
            | "endToEnd";
          count: number;
        }>;
        earlyStatusPriority?: {
          level: "prioritize" | "observe" | "deprioritize";
          reason: string;
        };
      };
      earlyStatus?: {
        sampleCount: number;
        eligibleCount: number;
        semanticGateCount: number;
        latencyGateCount: number;
        topReasons?: Array<{
          reason: string;
          count: number;
        }>;
        guidance?: {
          focus:
            | "expand_active_run_status"
            | "tighten_semantic_contract"
            | "optimize_other_bottlenecks"
            | "observe_more_samples";
          reason: string;
        };
        phase2Supplements?: {
          sampleCount: number;
          eligibleCount: number;
          hitRatePct: number;
          topSkipReasons?: Array<{
            reason: string;
            count: number;
          }>;
          statusFirstVisibleAvgMs?: number;
          statusFirstVisibleP95Ms?: number;
        };
      };
    };
  };
  channelSummary: string[];
  queuedSystemEvents: string[];
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
