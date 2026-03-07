import type { ToolActivityRecord } from "../tool-activity-registry.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import {
  listFinishedSessions,
  listRunningSessions,
  type ProcessStatus,
} from "../../agents/bash-process-registry.js";
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
  tools: {
    summary: {
      active: number;
      recent: number;
      failedRecent: number;
      uniqueToolsActive: number;
    };
    active: ToolActivityRecord[];
    recent: ToolActivityRecord[];
  };
  processes: {
    summary: {
      running: number;
      recent: number;
      failedRecent: number;
      killedRecent: number;
    };
    running: DashboardProcessSummaryEntry[];
    recent: DashboardProcessSummaryEntry[];
  };
  autonomy: {
    summary: {
      agents: number;
      explicitToolPolicies: number;
      nodeBoundAgents: number;
      elevatedAgents: number;
      workspaceOnly: boolean;
      applyPatchEnabled: boolean;
    };
    exec: {
      host: "sandbox" | "gateway" | "node";
      security: "deny" | "allowlist" | "full";
      ask: "off" | "on-miss" | "always";
      node: string | null;
      backgroundMs: number | null;
      timeoutSec: number | null;
      approvalRunningNoticeMs: number | null;
    };
    fs: {
      workspaceOnly: boolean;
    };
    applyPatch: {
      enabled: boolean;
      workspaceOnly: boolean;
      allowModels: string[];
    };
    elevated: {
      enabled: boolean;
      providers: string[];
    };
    agents: Array<{
      agentId: string;
      name: string | null;
      toolProfile: string | null;
      allowCount: number;
      denyCount: number;
      alsoAllowCount: number;
      execHost: string | null;
      execSecurity: string | null;
      execAsk: string | null;
      execNode: string | null;
      workspaceOnly: boolean;
      elevatedEnabled: boolean | null;
    }>;
  };
  incidents: {
    summary: GatewayIncidentSummary;
    active: GatewayIncidentRecord[];
  };
};

type DashboardProcessSummaryEntry = {
  sessionId: string;
  command: string;
  sessionKey: string | null;
  scopeKey: string | null;
  status: ProcessStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  cwd: string | null;
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | number | null;
  tail: string | null;
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

function summarizeProcessEntries(): DashboardSummaryPayload["processes"] {
  const now = Date.now();
  const runningSessions = listRunningSessions();
  const finishedSessions = listFinishedSessions();
  return {
    summary: {
      running: runningSessions.length,
      recent: finishedSessions.length,
      failedRecent: finishedSessions.filter((entry) => entry.status === "failed").length,
      killedRecent: finishedSessions.filter((entry) => entry.status === "killed").length,
    },
    running: runningSessions
      .toSorted((left, right) => right.startedAt - left.startedAt)
      .slice(0, 8)
      .map((entry) => ({
        sessionId: entry.id,
        command: entry.command,
        sessionKey: entry.sessionKey ?? null,
        scopeKey: entry.scopeKey ?? null,
        status: "running" as const,
        startedAt: entry.startedAt,
        endedAt: null,
        durationMs: now - entry.startedAt,
        cwd: entry.cwd ?? null,
        pid: entry.pid ?? null,
        exitCode: null,
        exitSignal: null,
        tail: clampDashboardText(entry.tail, 220),
      })),
    recent: finishedSessions
      .toSorted((left, right) => right.endedAt - left.endedAt)
      .slice(0, 8)
      .map((entry) => ({
        sessionId: entry.id,
        command: entry.command,
        sessionKey: entry.sessionKey ?? null,
        scopeKey: entry.scopeKey ?? null,
        status: entry.status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        durationMs: Math.max(0, entry.endedAt - entry.startedAt),
        cwd: entry.cwd ?? null,
        pid: null,
        exitCode: entry.exitCode ?? null,
        exitSignal: entry.exitSignal ?? null,
        tail: clampDashboardText(entry.tail, 220),
      })),
  };
}

function summarizeAutonomy(
  cfg: ReturnType<typeof loadConfig>,
): DashboardSummaryPayload["autonomy"] {
  const tools = cfg.tools ?? {};
  const globalExec = tools.exec ?? {};
  const execHost = globalExec.host ?? "sandbox";
  const execSecurity = globalExec.security ?? (execHost === "sandbox" ? "deny" : "allowlist");
  const execAsk = globalExec.ask ?? "on-miss";
  const fsWorkspaceOnly = tools.fs?.workspaceOnly === true;
  const applyPatchConfig = globalExec.applyPatch;
  const applyPatchWorkspaceOnly = fsWorkspaceOnly || applyPatchConfig?.workspaceOnly !== false;
  const elevatedAllowFrom = tools.elevated?.allowFrom ?? {};
  const elevatedProviders = Object.keys(elevatedAllowFrom).filter((entry) => entry.trim());
  const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agents = configuredAgents.map((entry) => {
    const agentTools = entry.tools ?? {};
    const agentExec = agentTools.exec ?? {};
    const agentFs = agentTools.fs ?? {};
    const allow = Array.isArray(agentTools.allow) ? agentTools.allow.filter(Boolean) : [];
    const deny = Array.isArray(agentTools.deny) ? agentTools.deny.filter(Boolean) : [];
    const alsoAllow = Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow.filter(Boolean)
      : [];
    return {
      agentId: entry.id,
      name: entry.name?.trim() || null,
      toolProfile: agentTools.profile ?? null,
      allowCount: allow.length,
      denyCount: deny.length,
      alsoAllowCount: alsoAllow.length,
      execHost: agentExec.host ?? null,
      execSecurity: agentExec.security ?? null,
      execAsk: agentExec.ask ?? null,
      execNode: agentExec.node?.trim() || null,
      workspaceOnly: agentFs.workspaceOnly === true,
      elevatedEnabled:
        typeof agentTools.elevated?.enabled === "boolean" ? agentTools.elevated.enabled : null,
    };
  });
  const explicitToolPolicies = agents.filter(
    (entry) =>
      entry.toolProfile ||
      entry.allowCount > 0 ||
      entry.denyCount > 0 ||
      entry.alsoAllowCount > 0 ||
      entry.execHost ||
      entry.execSecurity ||
      entry.execAsk ||
      entry.execNode ||
      entry.workspaceOnly ||
      entry.elevatedEnabled !== null,
  ).length;

  return {
    summary: {
      agents: Math.max(1, agents.length),
      explicitToolPolicies,
      nodeBoundAgents: agents.filter((entry) => Boolean(entry.execNode)).length,
      elevatedAgents: agents.filter((entry) => entry.elevatedEnabled === true).length,
      workspaceOnly: fsWorkspaceOnly,
      applyPatchEnabled: applyPatchConfig?.enabled === true,
    },
    exec: {
      host: execHost,
      security: execSecurity,
      ask: execAsk,
      node: globalExec.node?.trim() || null,
      backgroundMs: typeof globalExec.backgroundMs === "number" ? globalExec.backgroundMs : null,
      timeoutSec: typeof globalExec.timeoutSec === "number" ? globalExec.timeoutSec : null,
      approvalRunningNoticeMs:
        typeof globalExec.approvalRunningNoticeMs === "number"
          ? globalExec.approvalRunningNoticeMs
          : null,
    },
    fs: {
      workspaceOnly: fsWorkspaceOnly,
    },
    applyPatch: {
      enabled: applyPatchConfig?.enabled === true,
      workspaceOnly: applyPatchWorkspaceOnly,
      allowModels: Array.isArray(applyPatchConfig?.allowModels)
        ? applyPatchConfig.allowModels.filter((entry): entry is string => typeof entry === "string")
        : [],
    },
    elevated: {
      enabled: tools.elevated?.enabled !== false,
      providers: elevatedProviders,
    },
    agents,
  };
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
    | "execApprovalManager"
    | "incidentManager"
    | "nodeRegistry"
    | "hasConnectedMobileNode"
    | "toolActivityRegistry"
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
  const cfg = loadConfig();
  const topFindings = sortFindings(security.report.findings)
    .filter((entry) => entry.severity === "critical" || entry.severity === "warn")
    .slice(0, 6);
  const toolSnapshot = context.toolActivityRegistry?.snapshot({
    activeLimit: 8,
    recentLimit: 8,
  }) ?? {
    summary: { active: 0, recent: 0, failedRecent: 0, uniqueToolsActive: 0 },
    active: [],
    recent: [],
  };
  const processSnapshot = summarizeProcessEntries();
  const autonomy = summarizeAutonomy(cfg);
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
    tools: toolSnapshot,
    processes: processSnapshot,
    autonomy,
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
    | "toolActivityRegistry"
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
    | "toolActivityRegistry"
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
