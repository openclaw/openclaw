import type { QuantdRuntimeSummary } from "../quantd/runtime-summary.js";

export type AgentActivityStatus = "active" | "quiet" | "idle";

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
};

const ACTIVE_WINDOW_MS = 15 * 60_000;
const QUIET_WINDOW_MS = 60 * 60_000;

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
  return {
    status:
      params.quantd.status === "degraded" || params.quantd.status === "unreachable"
        ? "degraded"
        : "ok",
    agents,
    quantd: {
      status: params.quantd.status,
    },
  };
}
