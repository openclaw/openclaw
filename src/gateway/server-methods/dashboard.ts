import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { getActiveEmbeddedRunCount } from "../../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../../auto-reply/reply/dispatcher-registry.js";
import { loadConfig } from "../../config/config.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { getTotalQueueSize } from "../../process/command-queue.js";
import {
  runSecurityAudit,
  type SecurityAuditFinding,
  type SecurityAuditReport,
} from "../../security/audit.js";
import {
  type GatewayIncidentCandidate,
  type GatewayIncidentRecord,
  type GatewayIncidentSummary,
} from "../incident-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

const SECURITY_AUDIT_CACHE_TTL_MS = 2 * 60 * 1000;

type CachedSecurityAudit = {
  report: SecurityAuditReport;
  cachedAtMs: number;
};

let securityAuditCache: CachedSecurityAudit | null = null;
let securityAuditInFlight: Promise<CachedSecurityAudit> | null = null;
const dashboardDeltaTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

export type DashboardSummaryPayload = {
  ts: number;
  security: {
    ts: number;
    cached: boolean;
    summary: SecurityAuditReport["summary"];
    topFindings: SecurityAuditFinding[];
  };
  approvals: {
    count: number;
    pending: ReturnType<NonNullable<GatewayRequestContext["execApprovalManager"]>["listPending"]>;
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
    summary: GatewayIncidentSummary;
    active: GatewayIncidentRecord[];
  };
};

function sortFindings(findings: SecurityAuditFinding[]): SecurityAuditFinding[] {
  const rank = (severity: SecurityAuditFinding["severity"]) =>
    severity === "critical" ? 0 : severity === "warn" ? 1 : 2;
  return [...findings].toSorted((left, right) => {
    const severityDelta = rank(left.severity) - rank(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.title.localeCompare(right.title);
  });
}

async function loadSecurityAuditCached(params?: { force?: boolean }): Promise<{
  report: SecurityAuditReport;
  cached: boolean;
}> {
  const now = Date.now();
  const force = params?.force === true;
  if (
    !force &&
    securityAuditCache &&
    now - securityAuditCache.cachedAtMs < SECURITY_AUDIT_CACHE_TTL_MS
  ) {
    return { report: securityAuditCache.report, cached: true };
  }
  if (securityAuditInFlight) {
    const result = await securityAuditInFlight;
    return { report: result.report, cached: true };
  }
  securityAuditInFlight = (async () => {
    const cfg = loadConfig();
    const report = await runSecurityAudit({
      config: cfg,
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
    });
    const next = { report, cachedAtMs: Date.now() };
    securityAuditCache = next;
    return next;
  })().finally(() => {
    securityAuditInFlight = null;
  });
  const result = await securityAuditInFlight;
  return { report: result.report, cached: false };
}

function clampDashboardText(value: string | null | undefined, max = 140): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveConnectedNodeIds(
  nodes: ReturnType<NonNullable<GatewayRequestContext["nodeRegistry"]>["listConnected"]>,
): Set<string> {
  return new Set(
    nodes
      .map((node) => {
        if (typeof node.nodeId === "string" && node.nodeId.trim()) {
          return node.nodeId.trim();
        }
        if ("id" in node && typeof node.id === "string" && node.id.trim()) {
          return node.id.trim();
        }
        return "";
      })
      .filter(Boolean),
  );
}

function buildIncidentCandidates(params: {
  approvals: ReturnType<NonNullable<GatewayRequestContext["execApprovalManager"]>["listPending"]>;
  devices: Awaited<ReturnType<typeof listDevicePairing>>;
  nodes: ReturnType<NonNullable<GatewayRequestContext["nodeRegistry"]>["listConnected"]>;
  hasMobileNodeConnected: boolean;
  queueSize: number;
  pendingReplies: number;
  activeEmbeddedRuns: number;
  security: { topFindings: SecurityAuditFinding[] };
}): GatewayIncidentCandidate[] {
  const incidents: GatewayIncidentCandidate[] = [];
  const connectedNodeIds = resolveConnectedNodeIds(params.nodes);

  for (const approval of params.approvals.slice(0, 6)) {
    incidents.push({
      id: `approval:${approval.id}`,
      source: "approval",
      severity: "warn",
      title: clampDashboardText(approval.request.command, 72) || `Approval ${approval.id}`,
      detail: `Exec approval waiting${approval.request.agentId ? ` · ${approval.request.agentId}` : ""}`,
      metadata: {
        logQuery: approval.request.command,
        sessionKey: approval.request.sessionKey ?? null,
        agentId: approval.request.agentId ?? null,
      },
    });
  }

  for (const finding of params.security.topFindings.slice(0, 6)) {
    incidents.push({
      id: `security:${finding.title}`,
      source: "security",
      severity: finding.severity,
      title: finding.title,
      detail: clampDashboardText(finding.detail, 160) || "Security finding requires review.",
      metadata: {
        logQuery: finding.title,
        actionTab: "config",
        actionLabel: "Open config",
      },
    });
  }

  for (const request of params.devices.pending.slice(0, 6)) {
    const label = request.displayName?.trim() || request.deviceId;
    incidents.push({
      id: `device:${request.requestId}`,
      source: "device",
      severity: "warn",
      title: `${label} awaiting pairing`,
      detail: `Device pairing request is waiting for operator approval${request.remoteIp ? ` · ${request.remoteIp}` : ""}.`,
      metadata: {
        nodeId: request.deviceId,
        actionTab: "nodes",
        actionLabel: "Open nodes",
      },
    });
  }

  for (const device of params.devices.paired.slice(0, 6)) {
    const deviceId = device.deviceId?.trim();
    if (!deviceId || connectedNodeIds.has(deviceId)) {
      continue;
    }
    const label = device.displayName?.trim() || deviceId;
    incidents.push({
      id: `node:${deviceId}`,
      source: "node",
      severity: "warn",
      title: `${label} offline`,
      detail: "A paired node is not connected to the gateway.",
      metadata: {
        nodeId: deviceId,
        logQuery: deviceId,
        actionTab: "nodes",
        actionLabel: "Open nodes",
      },
    });
  }

  const queuePressure = params.queueSize + params.pendingReplies + params.activeEmbeddedRuns;
  if (queuePressure > 0) {
    incidents.push({
      id: "runtime:queue-pressure",
      source: "runtime",
      severity: queuePressure >= 6 ? "critical" : "warn",
      title: "Runtime queue pressure",
      detail: `${params.queueSize} queued · ${params.pendingReplies} pending replies · ${params.activeEmbeddedRuns} embedded runs`,
      metadata: {
        actionTab: "instances",
        actionLabel: "Open runtime",
      },
    });
  }

  if (
    !params.hasMobileNodeConnected &&
    params.nodes.length === 0 &&
    params.devices.paired.length > 0
  ) {
    incidents.push({
      id: "node:no-live-links",
      source: "node",
      severity: "warn",
      title: "No live node links",
      detail: "Paired devices exist, but no node is currently connected to the gateway.",
      metadata: {
        actionTab: "nodes",
        actionLabel: "Open nodes",
      },
    });
  }

  return incidents;
}

export async function buildDashboardSummary(
  context: Pick<
    GatewayRequestContext,
    "execApprovalManager" | "incidentManager" | "nodeRegistry" | "hasConnectedMobileNode"
  >,
  params?: { forceAudit?: boolean },
): Promise<DashboardSummaryPayload> {
  const [devices, security] = await Promise.all([
    listDevicePairing(),
    loadSecurityAuditCached({ force: params?.forceAudit === true }),
  ]);
  const approvals = context.execApprovalManager?.listPending() ?? [];
  const nodes = context.nodeRegistry.listConnected();
  const queueSize = getTotalQueueSize();
  const pendingReplies = getTotalPendingReplies();
  const activeEmbeddedRuns = getActiveEmbeddedRunCount();
  const topFindings = sortFindings(security.report.findings)
    .filter((entry) => entry.severity === "critical" || entry.severity === "warn")
    .slice(0, 6);
  const incidentCandidates = buildIncidentCandidates({
    approvals,
    devices,
    nodes,
    hasMobileNodeConnected: context.hasConnectedMobileNode(),
    queueSize,
    pendingReplies,
    activeEmbeddedRuns,
    security: { topFindings },
  });
  context.incidentManager?.sync(incidentCandidates);
  const incidentSummary = context.incidentManager?.summarize() ?? {
    active: 0,
    open: 0,
    acked: 0,
    resolved: 0,
    critical: 0,
    warn: 0,
    info: 0,
  };
  const activeIncidents = context.incidentManager?.list({ status: "active", limit: 8 }) ?? [];
  const hasMobileNodeConnected = context.hasConnectedMobileNode();

  return {
    ts: Date.now(),
    security: {
      ts: security.report.ts,
      cached: security.cached,
      summary: security.report.summary,
      topFindings,
    },
    approvals: {
      count: approvals.length,
      pending: approvals,
    },
    devices: {
      pending: devices.pending.length,
      paired: devices.paired.length,
    },
    nodes: {
      count: nodes.length,
      hasMobileNodeConnected,
    },
    runtime: {
      queueSize,
      pendingReplies,
      activeEmbeddedRuns,
    },
    incidents: {
      summary: incidentSummary,
      active: activeIncidents,
    },
  };
}

export async function broadcastDashboardDelta(
  context: Pick<
    GatewayRequestContext,
    | "broadcast"
    | "execApprovalManager"
    | "incidentManager"
    | "nodeRegistry"
    | "hasConnectedMobileNode"
    | "logGateway"
  >,
  params?: { forceAudit?: boolean },
) {
  try {
    const payload = await buildDashboardSummary(context, params);
    context.broadcast("dashboard.delta", payload, { dropIfSlow: true });
    return payload;
  } catch (err) {
    context.logGateway.warn(`dashboard.delta failed: ${formatForLog(err)}`);
    return null;
  }
}

export function scheduleDashboardDelta(
  context: Pick<
    GatewayRequestContext,
    | "broadcast"
    | "execApprovalManager"
    | "incidentManager"
    | "nodeRegistry"
    | "hasConnectedMobileNode"
    | "logGateway"
  >,
  delayMs = 750,
) {
  if (dashboardDeltaTimers.has(context)) {
    return;
  }
  const timer = setTimeout(() => {
    dashboardDeltaTimers.delete(context);
    void broadcastDashboardDelta(context);
  }, delayMs);
  dashboardDeltaTimers.set(context, timer);
}

export const dashboardHandlers: GatewayRequestHandlers = {
  "dashboard.summary": async ({ respond, context, params }) => {
    try {
      const payload = await buildDashboardSummary(context, {
        forceAudit: params?.forceAudit === true,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
