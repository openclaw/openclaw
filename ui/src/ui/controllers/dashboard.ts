import type { GatewayBrowserClient } from "../gateway.ts";
import type { ExecApprovalRequest } from "./exec-approval.ts";

export type DashboardSecurityFinding = {
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

export type DashboardIncidentStatus = "open" | "acked" | "resolved";

export type DashboardIncidentRecord = {
  id: string;
  source: "approval" | "device" | "node" | "runtime" | "security";
  severity: "info" | "warn" | "critical";
  status: DashboardIncidentStatus;
  title: string;
  detail: string;
  metadata: {
    logQuery?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
    channelId?: string | null;
    nodeId?: string | null;
    actionTab?: string | null;
    actionLabel?: string | null;
  };
  firstDetectedAt: number;
  lastSeenAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string | null;
  resolvedAt?: number;
  resolvedBy?: string | null;
  occurrenceCount: number;
};

export type DashboardSummaryResult = {
  ts: number;
  security: {
    ts: number;
    cached: boolean;
    summary: {
      critical: number;
      warn: number;
      info: number;
    };
    topFindings: DashboardSecurityFinding[];
  };
  approvals: {
    count: number;
    pending: ExecApprovalRequest[];
  };
  devices: {
    pending: number;
    paired: number;
  };
  nodes: {
    count: number;
    hasMobileNodeConnected: boolean;
  };
  runtime: {
    queueSize: number;
    pendingReplies: number;
    activeEmbeddedRuns: number;
  };
  incidents: {
    summary: {
      active: number;
      open: number;
      acked: number;
      resolved: number;
      critical: number;
      warn: number;
      info: number;
    };
    active: DashboardIncidentRecord[];
  };
};

export type DashboardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  dashboardLoading: boolean;
  dashboardSummary: DashboardSummaryResult | null;
  dashboardError: string | null;
  execApprovalQueue: ExecApprovalRequest[];
};

async function mutateDashboardIncident(
  state: DashboardState,
  method: "incident.ack" | "incident.resolve",
  id: string,
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const incidentId = id.trim();
  if (!incidentId) {
    return false;
  }
  try {
    await state.client.request(method, { id: incidentId });
    state.dashboardError = null;
    await loadDashboardSummary(state, { quiet: true });
    return true;
  } catch (err) {
    state.dashboardError = String(err);
    return false;
  }
}

export function applyDashboardSummary(state: DashboardState, summary: DashboardSummaryResult) {
  state.dashboardSummary = summary;
  state.dashboardError = null;
  state.execApprovalQueue = Array.isArray(summary.approvals?.pending)
    ? summary.approvals.pending
    : state.execApprovalQueue;
}

export async function loadDashboardSummary(
  state: DashboardState,
  opts?: { quiet?: boolean; forceAudit?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.dashboardLoading) {
    return;
  }
  state.dashboardLoading = true;
  if (!opts?.quiet) {
    state.dashboardError = null;
  }
  try {
    const summary = await state.client.request<DashboardSummaryResult>("dashboard.summary", {
      forceAudit: opts?.forceAudit === true,
    });
    applyDashboardSummary(state, summary);
  } catch (err) {
    state.dashboardError = String(err);
  } finally {
    state.dashboardLoading = false;
  }
}

export async function ackDashboardIncident(state: DashboardState, id: string) {
  return await mutateDashboardIncident(state, "incident.ack", id);
}

export async function resolveDashboardIncident(state: DashboardState, id: string) {
  return await mutateDashboardIncident(state, "incident.resolve", id);
}
