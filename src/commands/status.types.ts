import type { ChannelId } from "../channels/plugins/types.js";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
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

export type OptimizerStats = {
  cache: {
    hits: number;
    misses: number;
    evictions: number;
    stampedePrevented: number;
    skippedForTools: number;
    hitRate: string;
    size: number;
    maxSize: number;
    byteSize: number;
    maxByteSize: number;
  };
  pool: {
    httpRequestsServed: number;
    httpConnectionsReused: number;
    errors: number;
    httpPools: number;
  };
  queue: {
    queued: number;
    processed: number;
    succeeded: number;
    failed: number;
    retried: number;
    active: number;
    isPaused: boolean;
  };
  monitor: {
    uptime: {
      ms: number;
      formatted: string;
    };
    memory: {
      heapUsed: number;
      heapTotal: number;
      rss: number;
      external: number;
    };
    counters: {
      requests: number;
      errors: number;
      cacheHits: number;
      cacheMisses: number;
      messages: number;
    };
    rates: {
      requestsPerSecond: number;
      errorRate: number;
      cacheHitRate: number;
    };
  };
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
  optimizer?: OptimizerStats;
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
