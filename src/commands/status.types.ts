import type { ChannelId } from "../channels/plugins/types.js";

export type SessionKind = "direct" | "group" | "global" | "unknown";

/**
 * Session type classification for better UX in status output.
 * - main: Primary interactive session (agent:main:main, etc.)
 * - cronJob: Cron job definition (agent:main:cron:xxx)
 * - cronRun: Individual cron execution (agent:main:cron:xxx:run:yyy)
 * - other: Everything else
 */
export type SessionType = "main" | "cronJob" | "cronRun" | "other";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: SessionKind;
  /** Classified session type for grouping */
  sessionType: SessionType;
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
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

export type SessionGroup = {
  /** Group label for display */
  label: string;
  /** Number of sessions in this group */
  count: number;
  /** Sessions in this group (may be truncated) */
  sessions: SessionStatus[];
  /** Whether this group is collapsed by default */
  collapsed: boolean;
};

/**
 * Grouped sessions by type for improved status output.
 */
export type SessionGroups = {
  /** Primary interactive sessions */
  active: SessionGroup;
  /** Cron job definitions */
  cronJobs: SessionGroup;
  /** Individual cron run history */
  cronRuns: SessionGroup;
  /** All other sessions */
  other: SessionGroup;
};

export type StatusSummary = {
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
    /** Grouped sessions for better UX (new) */
    grouped?: SessionGroups;
  };
};
