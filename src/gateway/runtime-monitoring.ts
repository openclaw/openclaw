import type { QuantdRuntimeSummary } from "../quantd/runtime-summary.js";

export type AgentActivityStatus = "active" | "quiet" | "idle";
export type FormalRuntimeIssuePriority = "P0" | "P1" | "P2" | "INFO";

export type FormalRuntimeIssue = {
  code:
    | "quantd.unreachable"
    | "quantd.degraded"
    | "agents.default_idle"
    | "agents.all_idle"
    | "agents.heartbeat_disabled";
  priority: FormalRuntimeIssuePriority;
  summary: string;
};

export type AgentActivityEntry = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeatEnabled: boolean;
  heartbeatEveryMs: number | null;
  lastSessionAt: number | null;
  lastSessionAgeMs: number | null;
  status: AgentActivityStatus;
};

export type AgentActivitySummary = {
  defaultAgentId: string;
  total: number;
  active: number;
  quiet: number;
  idle: number;
  heartbeatEnabled: number;
  heartbeatDisabled: number;
  entries: AgentActivityEntry[];
};

export type FormalRuntimeMonitoringSummary = {
  status: "ok" | "degraded";
  agents: AgentActivitySummary;
  quantd: {
    status: QuantdRuntimeSummary["status"];
  };
  issues: FormalRuntimeIssue[];
  issueCounts: Record<FormalRuntimeIssuePriority, number>;
};

const ACTIVE_WINDOW_MS = 15 * 60_000;
const QUIET_WINDOW_MS = 60 * 60_000;
const EMPTY_ISSUE_COUNTS: Record<FormalRuntimeIssuePriority, number> = {
  P0: 0,
  P1: 0,
  P2: 0,
  INFO: 0,
};

function resolveAgentActivityStatus(ageMs: number | null): AgentActivityStatus {
  if (ageMs === null) {
    return "idle";
  }
  if (ageMs <= ACTIVE_WINDOW_MS) {
    return "active";
  }
  if (ageMs <= QUIET_WINDOW_MS) {
    return "quiet";
  }
  return "idle";
}

export function buildAgentActivitySummary(params: {
  defaultAgentId: string;
  agents: Array<{
    agentId: string;
    name?: string;
    isDefault: boolean;
    heartbeat: { enabled: boolean; everyMs: number | null };
    sessions: {
      recent: Array<{
        updatedAt: number | null;
      }>;
    };
  }>;
  now?: () => number;
}): AgentActivitySummary {
  const now = params.now ?? (() => Date.now());
  const entries = params.agents.map((agent) => {
    const lastSessionAt = agent.sessions.recent.find(
      (entry) => typeof entry.updatedAt === "number",
    )?.updatedAt;
    const lastSessionAgeMs =
      typeof lastSessionAt === "number" ? Math.max(0, now() - lastSessionAt) : null;
    return {
      agentId: agent.agentId,
      name: agent.name,
      isDefault: agent.isDefault,
      heartbeatEnabled: agent.heartbeat.enabled,
      heartbeatEveryMs: agent.heartbeat.everyMs,
      lastSessionAt: lastSessionAt ?? null,
      lastSessionAgeMs,
      status: resolveAgentActivityStatus(lastSessionAgeMs),
    } satisfies AgentActivityEntry;
  });

  return {
    defaultAgentId: params.defaultAgentId,
    total: entries.length,
    active: entries.filter((entry) => entry.status === "active").length,
    quiet: entries.filter((entry) => entry.status === "quiet").length,
    idle: entries.filter((entry) => entry.status === "idle").length,
    heartbeatEnabled: entries.filter((entry) => entry.heartbeatEnabled).length,
    heartbeatDisabled: entries.filter((entry) => !entry.heartbeatEnabled).length,
    entries,
  };
}

export function buildFormalRuntimeMonitoringSummary(params: {
  defaultAgentId: string;
  agents: Array<{
    agentId: string;
    name?: string;
    isDefault: boolean;
    heartbeat: { enabled: boolean; everyMs: number | null };
    sessions: {
      recent: Array<{
        updatedAt: number | null;
      }>;
    };
  }>;
  quantd: QuantdRuntimeSummary;
  now?: () => number;
}): FormalRuntimeMonitoringSummary {
  const agents = buildAgentActivitySummary({
    defaultAgentId: params.defaultAgentId,
    agents: params.agents,
    now: params.now,
  });
  const issues: FormalRuntimeIssue[] = [];
  if (params.quantd.status === "unreachable") {
    issues.push({
      code: "quantd.unreachable",
      priority: "P0",
      summary: "quantd currently unreachable",
    });
  } else if (params.quantd.status === "degraded") {
    issues.push({
      code: "quantd.degraded",
      priority: "P1",
      summary: "quantd is degraded",
    });
  }

  const defaultAgent = agents.entries.find((entry) => entry.isDefault);
  if (defaultAgent?.status === "idle") {
    issues.push({
      code: "agents.default_idle",
      priority: "P1",
      summary: `default agent ${defaultAgent.agentId} is idle`,
    });
  }
  if (agents.total > 0 && agents.idle === agents.total) {
    issues.push({
      code: "agents.all_idle",
      priority: "P2",
      summary: "all formal agents are idle",
    });
  }
  if (agents.heartbeatDisabled > 0) {
    issues.push({
      code: "agents.heartbeat_disabled",
      priority: "P2",
      summary: `${agents.heartbeatDisabled} formal agents have heartbeat disabled`,
    });
  }

  const issueCounts = issues.reduce<Record<FormalRuntimeIssuePriority, number>>(
    (counts, issue) => {
      counts[issue.priority] += 1;
      return counts;
    },
    { ...EMPTY_ISSUE_COUNTS },
  );

  return {
    status: issueCounts.P0 > 0 || issueCounts.P1 > 0 || issueCounts.P2 > 0 ? "degraded" : "ok",
    agents,
    quantd: {
      status: params.quantd.status,
    },
    issues,
    issueCounts,
  };
}
