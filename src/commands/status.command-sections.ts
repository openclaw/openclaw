import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildPairingConnectRecoveryTitle,
  describePairingConnectRequirement,
  type ConnectPairingRequiredReason,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { TableColumn } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatMissingChildRuntimeWarning } from "../infra/child-runtime-viability.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import {
  resolveMemoryVectorState,
  resolveMemoryFtsState,
  resolveMemoryCacheSummary,
  type Tone,
} from "../memory-host-sdk/status.js";
import { formatPluginCompatibilityNotice } from "../plugins/status-compatibility.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import { formatDeliveryQueueHealthLine, formatHealthChannelLines } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import { formatSqliteWalHealthWarning } from "./sqlite-wal-health.js";
import type { AgentLocalStatus } from "./status.agent-local.js";
import { formatPromptCacheCompact, formatTokensCompact, shortenText } from "./status.format.js";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

type AgentStatusLike = {
  defaultId?: string | null;
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: AgentLocalStatus[];
};

type SummaryLike = Pick<StatusSummary, "heartbeat" | "sessions">;
type MemoryLike = MemoryStatusSnapshot | null;
type SessionsRecentLike = StatusSummary["sessions"]["recent"][number];
type EventLoopHealthLike = NonNullable<HealthSummary["eventLoop"]>;

type PairingRecoveryLike = {
  requestId?: string | null;
  reason?: ConnectPairingRequiredReason | null;
  remediationHint?: string | null;
};

export const statusHealthColumns: TableColumn[] = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Status", header: "Status", minWidth: 8 },
  { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
];

export function buildStatusAgentsValue(params: { agentStatus: AgentStatusLike }) {
  const pending =
    params.agentStatus.bootstrapPendingCount > 0
      ? `${params.agentStatus.bootstrapPendingCount} bootstrap file${params.agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present`
      : "no workspaces bootstrapping";
  const def = params.agentStatus.agents.find((a) => a.id === params.agentStatus.defaultId);
  const defActive = def?.lastActiveAgeMs != null ? formatTimeAgo(def.lastActiveAgeMs) : "unknown";
  const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
  return `${params.agentStatus.agents.length} · ${pending} · sessions ${params.agentStatus.totalSessions}${defSuffix}`;
}

export function buildStatusHeartbeatValue(params: { summary: Pick<SummaryLike, "heartbeat"> }) {
  const parts = params.summary.heartbeat.agents.map((agent) => {
    if (!agent.enabled || !agent.everyMs) {
      return `disabled (${agent.agentId})`;
    }
    if (agent.waitingForRoute) {
      return `${agent.every} (${agent.agentId}; waiting for delivery route — set commands.ownerAllowFrom=["telegram:123456789"] or channel allowFrom; explicit delivery: heartbeat.target="telegram" with heartbeat.to="123456789")`;
    }
    return `${agent.every} (${agent.agentId})`;
  });
  return parts.length > 0 ? parts.join(", ") : "disabled";
}

export function buildStatusLastHeartbeatValue(params: {
  deep?: boolean;
  gatewayReachable: boolean;
  gatewayStartupPhase?: string;
  lastHeartbeat: HeartbeatEventPayload | null;
}) {
  if (!params.deep) {
    // Fast status omits the row entirely instead of implying heartbeat is missing.
    return null;
  }
  if (params.gatewayStartupPhase) {
    return theme.muted(`not checked (gateway still starting; phase ${params.gatewayStartupPhase})`);
  }
  if (!params.gatewayReachable) {
    return theme.warn("unavailable");
  }
  if (!params.lastHeartbeat) {
    return theme.muted("none");
  }
  const age = formatTimeAgo(Date.now() - params.lastHeartbeat.ts);
  const accountLabel = params.lastHeartbeat.accountId
    ? `account ${params.lastHeartbeat.accountId}`
    : null;
  return [params.lastHeartbeat.status, age, params.lastHeartbeat.channel, accountLabel]
    .filter(Boolean)
    .join(" · ");
}

export function buildStatusMemoryValue(params: {
  memory: MemoryLike;
  memoryPlugin: MemoryPluginStatus;
  memoryUnavailableLabel?: string;
}) {
  if (!params.memoryPlugin.enabled) {
    const suffix = params.memoryPlugin.reason ? ` (${params.memoryPlugin.reason})` : "";
    return theme.muted(`disabled${suffix}`);
  }
  if (!params.memory) {
    const slot = params.memoryPlugin.slot ? `plugin ${params.memoryPlugin.slot}` : "plugin";
    return theme.muted(`enabled (${slot}) · ${params.memoryUnavailableLabel ?? "unavailable"}`);
  }
  const parts: string[] = [];
  const dirtySuffix = params.memory.dirty ? ` · ${theme.warn("dirty")}` : "";
  parts.push(`${params.memory.files} files · ${params.memory.chunks} chunks${dirtySuffix}`);
  if (params.memory.sources?.length) {
    parts.push(`sources ${params.memory.sources.join(", ")}`);
  }
  if (params.memoryPlugin.slot) {
    parts.push(`plugin ${params.memoryPlugin.slot}`);
  }
  const colorByTone = (tone: Tone, text: string) =>
    tone === "ok" ? theme.success(text) : tone === "warn" ? theme.warn(text) : theme.muted(text);
  if (params.memory.vector) {
    const vector =
      params.memory.backend === "builtin" && params.memory.vector.storeAvailable !== undefined
        ? // Built-in memory reports store availability under a backend-specific field.
          { ...params.memory.vector, available: params.memory.vector.storeAvailable }
        : params.memory.vector;
    const state = resolveMemoryVectorState(vector);
    const prefix = params.memory.backend === "builtin" ? "vector store" : "vector";
    const label = state.state === "disabled" ? `${prefix} off` : `${prefix} ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.fts) {
    const state = resolveMemoryFtsState(params.memory.fts);
    const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.cache) {
    const summary = resolveMemoryCacheSummary(params.memory.cache);
    parts.push(colorByTone(summary.tone, summary.text));
  }
  return parts.join(" · ");
}

export function buildStatusSecurityAuditLines(params: {
  securityAudit: {
    summary: { critical: number; warn: number; info: number };
    findings: Array<{
      severity: "critical" | "warn" | "info";
      title: string;
      detail: string;
      remediation?: string | null;
    }>;
  };
}) {
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    return [
      theme.error(`${value.critical} critical`),
      theme.warn(`${value.warn} warn`),
      theme.muted(`${value.info} info`),
    ].join(" · ");
  };
  const lines = [theme.muted(`Summary: ${fmtSummary(params.securityAudit.summary)}`)];
  const importantFindings = params.securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    lines.push(theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") =>
      sev === "critical"
        ? theme.error("CRITICAL")
        : sev === "warn"
          ? theme.warn("WARN")
          : theme.muted("INFO");
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const shown = importantFindings
      // Always show critical findings before warnings, regardless of audit insertion order.
      .toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity))
      .slice(0, 6);
    for (const finding of shown) {
      lines.push(`  ${severityLabel(finding.severity)} ${finding.title}`);
      lines.push(`    ${shortenText(finding.detail.replaceAll("\n", " "), 160)}`);
      if (finding.remediation?.trim()) {
        lines.push(`    ${theme.muted(`Fix: ${finding.remediation.trim()}`)}`);
      }
    }
    if (importantFindings.length > shown.length) {
      lines.push(theme.muted(`… +${importantFindings.length - shown.length} more`));
    }
  }
  lines.push(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
  lines.push(theme.muted(`Deep probe: ${formatCliCommand("openclaw security audit --deep")}`));
  return lines;
}

export function buildStatusHealthRows(params: {
  health: HealthSummary;
  sqliteWal?: StatusSummary["sqliteWal"];
}) {
  const rows: Array<{ Item: string; Status: string; Detail: string }> = [
    {
      Item: "Gateway",
      Status: theme.success("reachable"),
      Detail: `${params.health.durationMs}ms`,
    },
  ];
  const childRuntimeWarning = params.health.childRuntime
    ? formatMissingChildRuntimeWarning(params.health.childRuntime)
    : undefined;
  if (childRuntimeWarning) {
    rows.push({
      Item: "Gateway runtime",
      Status: theme.warn("WARN"),
      Detail: childRuntimeWarning,
    });
  }
  const sqliteWalWarning = formatSqliteWalHealthWarning(params.sqliteWal);
  if (sqliteWalWarning) {
    rows.push({ Item: "SQLite WAL", Status: theme.warn("WARN"), Detail: sqliteWalWarning });
  }
  if (params.health.eventLoop) {
    rows.push({
      Item: "Event loop",
      Status: params.health.eventLoop.degraded ? theme.warn("WARN") : theme.success("OK"),
      Detail: formatEventLoopHealthDetail(params.health.eventLoop),
    });
  }
  const healthLines = formatHealthChannelLines(params.health, { accountMode: "all" });
  const deliveryQueueLine = formatDeliveryQueueHealthLine(params.health);
  if (deliveryQueueLine) {
    healthLines.push(deliveryQueueLine);
  }
  for (const line of healthLines) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const item = line.slice(0, colon).trim();
    const detail = line.slice(colon + 1).trim();
    const normalized = normalizeLowercaseStringOrEmpty(detail);
    // Shared health text uses known prefixes to classify table status chips.
    const status =
      normalized === "healthy" || normalized.startsWith("ok") || normalized.startsWith("configured")
        ? theme.success("OK")
        : normalized.startsWith("not configured") || normalized.startsWith("disabled")
          ? theme.muted("OFF")
          : normalized.startsWith("linked")
            ? theme.success("LINKED")
            : normalized.startsWith("not linked")
              ? theme.warn("UNLINKED")
              : theme.warn("WARN");
    rows.push({ Item: item, Status: status, Detail: detail });
  }
  return rows;
}

function formatEventLoopHealthDetail(eventLoop: EventLoopHealthLike): string {
  const parts = [
    eventLoop.degraded && eventLoop.degradedSinceMs != null
      ? `degraded for ${formatDurationCompact(eventLoop.degradedSinceMs) ?? "0s"}`
      : null,
    eventLoop.reasons.length > 0 ? `reasons ${eventLoop.reasons.join(",")}` : "healthy",
    `max ${Math.round(eventLoop.delayMaxMs)}ms`,
    `p99 ${Math.round(eventLoop.delayP99Ms)}ms`,
    `util ${eventLoop.utilization}`,
    `cpu ${eventLoop.cpuCoreRatio}`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export function buildStatusSessionsRows(params: {
  recent: SessionsRecentLike[];
  verbose?: boolean;
}) {
  return params.recent.map((sess) => ({
    Key: shortenText(sess.key, 32),
    Kind: sess.kind,
    Age: sess.updatedAt && sess.age != null ? formatTimeAgo(sess.age) : "no activity",
    Model: sess.model ?? "unknown",
    Runtime: sess.runtime ?? "unknown",
    Tokens: formatTokensCompact(sess),
    ...(params.verbose ? { Cache: formatPromptCacheCompact(sess) || theme.muted("—") } : {}),
  }));
}

/** Explains sessions pinned to a selected model different from the current configured default. */
export function buildStatusModelSelectionLines(params: {
  recent: SessionsRecentLike[];
  limit?: number;
}) {
  const mismatches = params.recent.filter((sess) => {
    if (!sess.configuredModel || !sess.selectedModel || !sess.modelSelectionReason) {
      return false;
    }
    return (
      sess.configuredModel !== sess.selectedModel &&
      // Runtime aliases such as provider-qualified model refs should not warn as real mismatches.
      !areRuntimeModelRefsEquivalent(sess.configuredModel, sess.selectedModel)
    );
  });
  if (mismatches.length === 0) {
    return [];
  }

  const limit = params.limit ?? 3;
  const lines: string[] = [];
  for (const sess of mismatches.slice(0, limit)) {
    const key = shortenText(sess.key, 48);
    const configured = sess.configuredModel ?? "unknown";
    const selected = sess.selectedModel ?? "unknown";
    const isFallback = sess.modelSelectionReason === "fallback selected";
    const intro = isFallback
      ? `Session ${key} is running ${selected} (auto fallback); config primary is ${configured}.`
      : `Session ${key} is pinned to ${selected}; config primary ${configured} will apply to new/unpinned sessions.`;
    const reasonLine = `  Reason: ${sess.modelSelectionReason ?? "session override"}`;
    const clearLine = isFallback
      ? "  Action: check provider availability or retry with /model"
      : "  Clear with: /model default";
    lines.push(
      theme.warn(intro),
      `  Configured default: ${configured}`,
      `  Session selected: ${selected}`,
      reasonLine,
      clearLine,
      "  Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-strictness",
    );
  }
  if (mismatches.length > limit) {
    lines.push(theme.muted(`  … +${mismatches.length - limit} more pinned session(s)`));
  }
  return lines;
}

export function buildStatusFooterLines(params: {
  updateHint: string | null;
  nodeOnlyGateway: unknown;
  gatewayReachable: boolean;
  gatewayStartupPhase?: string;
}) {
  return [
    "FAQ: https://docs.openclaw.ai/faq",
    "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
    ...(params.updateHint ? ["", theme.warn(params.updateHint)] : []),
    "Next steps:",
    `  Need to share?      ${formatCliCommand("openclaw status --all")}`,
    `  Need to debug live? ${formatCliCommand("openclaw logs --follow")}`,
    params.nodeOnlyGateway
      ? `  Need node service?  ${formatCliCommand("openclaw node status")}`
      : params.gatewayStartupPhase
        ? `  Retry after startup: ${formatCliCommand("openclaw status --deep")}`
        : params.gatewayReachable
          ? `  Need to test channels? ${formatCliCommand("openclaw status --deep")}`
          : `  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`,
  ];
}

export function buildStatusPluginCompatibilityLines(params: {
  notices: PluginCompatibilityNotice[];
  limit?: number;
}) {
  if (params.notices.length === 0) {
    return [];
  }
  const limit = params.limit ?? 8;
  return [
    ...params.notices.slice(0, limit).map((notice) => {
      const label = notice.severity === "warn" ? theme.warn("WARN") : theme.muted("INFO");
      return `  ${label} ${formatPluginCompatibilityNotice(notice)}`;
    }),
    ...(params.notices.length > limit
      ? [theme.muted(`  … +${params.notices.length - limit} more`)]
      : []),
  ];
}

export function buildStatusPairingRecoveryLines(params: {
  pairingRecovery: PairingRecoveryLike | null;
}) {
  if (!params.pairingRecovery) {
    return [];
  }
  return [
    theme.warn(buildPairingConnectRecoveryTitle(params.pairingRecovery.reason ?? undefined)),
    ...(params.pairingRecovery.reason
      ? [
          theme.muted(
            `Reason: ${describePairingConnectRequirement(params.pairingRecovery.reason)}.`,
          ),
        ]
      : []),
    ...(params.pairingRecovery.remediationHint
      ? [theme.muted(`Hint: ${params.pairingRecovery.remediationHint}`)]
      : []),
    ...(params.pairingRecovery.requestId
      ? [
          theme.muted(
            `Recovery: ${formatCliCommand(`openclaw devices approve ${params.pairingRecovery.requestId}`)}`,
          ),
        ]
      : []),
    theme.muted(`Fallback: ${formatCliCommand("openclaw devices approve --latest")}`),
    theme.muted(`Inspect: ${formatCliCommand("openclaw devices list")}`),
  ];
}

export function buildStatusSystemEventsRows(params: {
  queuedSystemEvents: string[];
  limit?: number;
}) {
  const limit = params.limit ?? 5;
  if (params.queuedSystemEvents.length === 0) {
    return undefined;
  }
  return params.queuedSystemEvents.slice(0, limit).map((event) => ({ Event: event }));
}

export function buildStatusSystemEventsTrailer(params: {
  queuedSystemEvents: string[];
  limit?: number;
}) {
  const limit = params.limit ?? 5;
  return params.queuedSystemEvents.length > limit
    ? theme.muted(`… +${params.queuedSystemEvents.length - limit} more`)
    : null;
}
