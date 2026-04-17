import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { Tone } from "../memory-host-sdk/status.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { TableColumn } from "../terminal/table.js";
import type { HealthSummary } from "./health.js";
import type { AgentLocalStatus } from "./status.agent-local.js";
import type { MemoryStatusSnapshot, MemoryPluginStatus } from "./status.scan.shared.js";
import type { A2AStatusSummary, SessionStatus, StatusContributorSummary, StatusSummary } from "./status.types.js";

type AgentStatusLike = {
  defaultId?: string | null;
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: AgentLocalStatus[];
};

type SummaryLike = Pick<StatusSummary, "a2a" | "contributors" | "tasks" | "taskAudit" | "heartbeat" | "sessions">;
type MemoryLike = MemoryStatusSnapshot | null;
type MemoryPluginLike = MemoryPluginStatus;
type SessionsRecentLike = SessionStatus;

type PluginCompatibilityNoticeLike = {
  severity?: "warn" | "info" | null;
};

type PairingRecoveryLike = {
  requestId?: string | null;
};

export const statusHealthColumns: TableColumn[] = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Status", header: "Status", minWidth: 8 },
  { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
];

export function buildStatusAgentsValue(params: {
  agentStatus: AgentStatusLike;
  formatTimeAgo: (ageMs: number) => string;
}) {
  const pending =
    params.agentStatus.bootstrapPendingCount > 0
      ? `${params.agentStatus.bootstrapPendingCount} bootstrap file${params.agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present`
      : "no bootstrap files";
  const def = params.agentStatus.agents.find((a) => a.id === params.agentStatus.defaultId);
  const defActive =
    def?.lastActiveAgeMs != null ? params.formatTimeAgo(def.lastActiveAgeMs) : "unknown";
  const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
  return `${params.agentStatus.agents.length} · ${pending} · sessions ${params.agentStatus.totalSessions}${defSuffix}`;
}

export function buildStatusTasksValue(params: {
  summary: Pick<SummaryLike, "tasks" | "taskAudit">;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  if (params.summary.tasks.total <= 0) {
    return params.muted("none");
  }
  return [
    `${params.summary.tasks.active} active`,
    `${params.summary.tasks.byStatus.queued} queued`,
    `${params.summary.tasks.byStatus.running} running`,
    params.summary.tasks.failures > 0
      ? params.warn(
          `${params.summary.tasks.failures} issue${params.summary.tasks.failures === 1 ? "" : "s"}`,
        )
      : params.muted("no issues"),
    params.summary.taskAudit.errors > 0
      ? params.warn(
          `audit ${params.summary.taskAudit.errors} error${params.summary.taskAudit.errors === 1 ? "" : "s"} · ${params.summary.taskAudit.warnings} warn`,
        )
      : params.summary.taskAudit.warnings > 0
        ? params.muted(`audit ${params.summary.taskAudit.warnings} warn`)
        : params.muted("audit clean"),
    `${params.summary.tasks.total} tracked`,
  ].join(" · ");
}

export type StatusContributorOverviewRow = {
  id: string;
  label: string;
  value: string;
};

function decorateStatusContributorSummary(params: {
  contributor: StatusContributorSummary;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  const summary = params.contributor.summary.trim();
  if (!summary) {
    return "";
  }
  if (params.contributor.state === "ok") {
    return params.ok(summary);
  }
  if (params.contributor.state === "warn" || params.contributor.state === "error") {
    return params.warn(summary);
  }
  return params.muted(summary);
}

export function buildStatusContributorOverviewRows(params: {
  summary: Pick<SummaryLike, "contributors">;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}): StatusContributorOverviewRow[] {
  const contributors = Array.isArray(params.summary.contributors)
    ? params.summary.contributors
    : [];
  return contributors
    .map((contributor) => {
      const label = contributor.label.trim();
      const summary = decorateStatusContributorSummary({
        contributor,
        ok: params.ok,
        warn: params.warn,
        muted: params.muted,
      });
      const details = Array.isArray(contributor.details)
        ? contributor.details
            .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
            .map((detail) => detail.trim())
        : [];
      const parts = [summary, ...details].filter(Boolean);
      if (!label || parts.length === 0) {
        return null;
      }
      return {
        id: contributor.id,
        label,
        value: parts.join(" · "),
      } satisfies StatusContributorOverviewRow;
    })
    .filter((row): row is StatusContributorOverviewRow => row !== null);
}

export function buildStatusA2AValue(params: {
  summary: Pick<SummaryLike, "a2a">;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  const a2a = params.summary.a2a;
  const decorateState = (value: string) => {
    if (a2a.state === "ok") {
      return params.ok(value);
    }
    if (a2a.state === "delayed") {
      return params.warn(value);
    }
    if (a2a.state === "waiting_external") {
      return params.warn(value);
    }
    if (a2a.state === "failed" || a2a.state === "config_error") {
      return params.warn(value);
    }
    return value;
  };

  const labelByState: Record<A2AStatusSummary["state"], string> = {
    ok: "ok",
    delayed: "delayed",
    waiting_external: "waiting external",
    failed: "failed",
    config_error: "config error",
  };

  const parts = [decorateState(labelByState[a2a.state])];
  parts.push(`broker ${a2a.broker.adapterEnabled ? "on" : "off"}`);
  if (a2a.tasks.active > 0) {
    parts.push(`${a2a.tasks.active} active`);
  } else {
    parts.push(params.muted("no active"));
  }
  if (a2a.tasks.waitingExternal > 0) {
    parts.push(`${a2a.tasks.waitingExternal} waiting external`);
  }
  if (a2a.tasks.delayed > 0) {
    parts.push(`${a2a.tasks.delayed} delayed`);
  }
  if (a2a.tasks.failed > 0) {
    parts.push(params.warn(`${a2a.tasks.failed} failed`));
  }
  if (a2a.state === "config_error") {
    const configHints: string[] = [];
    if (!a2a.broker.baseUrlPresent) {
      configHints.push("baseUrl missing");
    }
    if (!a2a.broker.methodScopesOk) {
      configHints.push("scope map missing");
    }
    if (configHints.length > 0) {
      parts.push(configHints.join(", "));
    }
  } else if (a2a.tasks.latestFailed) {
    const detail =
      a2a.tasks.latestFailed.errorMessage ??
      a2a.tasks.latestFailed.errorCode ??
      a2a.tasks.latestFailed.summary ??
      a2a.tasks.latestFailed.taskId;
    parts.push(`latest ${detail}`);
  }
  return parts.join(" · ");
}

export function buildStatusHeartbeatValue(params: { summary: Pick<SummaryLike, "heartbeat"> }) {
  const parts = params.summary.heartbeat.agents
    .map((agent) => {
      if (!agent.enabled || !agent.everyMs) {
        return `disabled (${agent.agentId})`;
      }
      return `${agent.every} (${agent.agentId})`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "disabled";
}

export function buildStatusLastHeartbeatValue(params: {
  deep?: boolean;
  gatewayReachable: boolean;
  lastHeartbeat: HeartbeatEventPayload | null;
  warn: (value: string) => string;
  muted: (value: string) => string;
  formatTimeAgo: (ageMs: number) => string;
}) {
  if (!params.deep) {
    return null;
  }
  if (!params.gatewayReachable) {
    return params.warn("unavailable");
  }
  if (!params.lastHeartbeat) {
    return params.muted("none");
  }
  const age = params.formatTimeAgo(Date.now() - params.lastHeartbeat.ts);
  const channel = params.lastHeartbeat.channel ?? "unknown";
  const accountLabel = params.lastHeartbeat.accountId
    ? `account ${params.lastHeartbeat.accountId}`
    : null;
  return [params.lastHeartbeat.status, `${age} ago`, channel, accountLabel]
    .filter(Boolean)
    .join(" · ");
}

export function buildStatusMemoryValue(params: {
  memory: MemoryLike;
  memoryPlugin: MemoryPluginLike;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
  resolveMemoryVectorState: (value: NonNullable<MemoryStatusSnapshot["vector"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryFtsState: (value: NonNullable<MemoryStatusSnapshot["fts"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryCacheSummary: (value: NonNullable<MemoryStatusSnapshot["cache"]>) => {
    text: string;
    tone: Tone;
  };
}) {
  if (!params.memoryPlugin.enabled) {
    const suffix = params.memoryPlugin.reason ? ` (${params.memoryPlugin.reason})` : "";
    return params.muted(`disabled${suffix}`);
  }
  if (!params.memory) {
    const slot = params.memoryPlugin.slot ? `plugin ${params.memoryPlugin.slot}` : "plugin";
    return params.muted(`enabled (${slot}) · unavailable`);
  }
  const parts: string[] = [];
  const dirtySuffix = params.memory.dirty ? ` · ${params.warn("dirty")}` : "";
  parts.push(`${params.memory.files} files · ${params.memory.chunks} chunks${dirtySuffix}`);
  if (params.memory.sources?.length) {
    parts.push(`sources ${params.memory.sources.join(", ")}`);
  }
  if (params.memoryPlugin.slot) {
    parts.push(`plugin ${params.memoryPlugin.slot}`);
  }
  const colorByTone = (tone: Tone, text: string) =>
    tone === "ok" ? params.ok(text) : tone === "warn" ? params.warn(text) : params.muted(text);
  if (params.memory.vector) {
    const state = params.resolveMemoryVectorState(params.memory.vector);
    const label = state.state === "disabled" ? "vector off" : `vector ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.fts) {
    const state = params.resolveMemoryFtsState(params.memory.fts);
    const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.cache) {
    const summary = params.resolveMemoryCacheSummary(params.memory.cache);
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
  theme: {
    error: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
  };
  shortenText: (value: string, maxLen: number) => string;
  formatCliCommand: (value: string) => string;
}) {
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    return [
      params.theme.error(`${value.critical} critical`),
      params.theme.warn(`${value.warn} warn`),
      params.theme.muted(`${value.info} info`),
    ].join(" · ");
  };
  const lines = [params.theme.muted(`Summary: ${fmtSummary(params.securityAudit.summary)}`)];
  const importantFindings = params.securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    lines.push(params.theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") =>
      sev === "critical"
        ? params.theme.error("CRITICAL")
        : sev === "warn"
          ? params.theme.warn("WARN")
          : params.theme.muted("INFO");
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const shown = [...importantFindings]
      .toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity))
      .slice(0, 6);
    for (const finding of shown) {
      lines.push(`  ${severityLabel(finding.severity)} ${finding.title}`);
      lines.push(`    ${params.shortenText(finding.detail.replaceAll("\n", " "), 160)}`);
      if (finding.remediation?.trim()) {
        lines.push(`    ${params.theme.muted(`Fix: ${finding.remediation.trim()}`)}`);
      }
    }
    if (importantFindings.length > shown.length) {
      lines.push(params.theme.muted(`… +${importantFindings.length - shown.length} more`));
    }
  }
  lines.push(
    params.theme.muted(`Full report: ${params.formatCliCommand("openclaw security audit")}`),
  );
  lines.push(
    params.theme.muted(`Deep probe: ${params.formatCliCommand("openclaw security audit --deep")}`),
  );
  return lines;
}

export function buildStatusHealthRows(params: {
  health: HealthSummary;
  formatHealthChannelLines: (summary: HealthSummary, opts: { accountMode: "all" }) => string[];
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  const rows: Array<Record<string, string>> = [
    {
      Item: "Gateway",
      Status: params.ok("reachable"),
      Detail: `${params.health.durationMs}ms`,
    },
  ];
  for (const line of params.formatHealthChannelLines(params.health, { accountMode: "all" })) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const item = line.slice(0, colon).trim();
    const detail = line.slice(colon + 1).trim();
    const normalized = normalizeLowercaseStringOrEmpty(detail);
    const status = normalized.startsWith("ok")
      ? params.ok("OK")
      : normalized.startsWith("failed")
        ? params.warn("WARN")
        : normalized.startsWith("not configured")
          ? params.muted("OFF")
          : normalized.startsWith("configured")
            ? params.ok("OK")
            : normalized.startsWith("linked")
              ? params.ok("LINKED")
              : normalized.startsWith("not linked")
                ? params.warn("UNLINKED")
                : params.warn("WARN");
    rows.push({ Item: item, Status: status, Detail: detail });
  }
  return rows;
}

export function buildStatusSessionsRows(params: {
  recent: SessionsRecentLike[];
  verbose?: boolean;
  shortenText: (value: string, maxLen: number) => string;
  formatTimeAgo: (ageMs: number) => string;
  formatTokensCompact: (value: SessionsRecentLike) => string;
  formatPromptCacheCompact: (value: SessionsRecentLike) => string | null;
  muted: (value: string) => string;
}) {
  if (params.recent.length === 0) {
    return [
      {
        Key: params.muted("no sessions yet"),
        Kind: "",
        Age: "",
        Model: "",
        Tokens: "",
        ...(params.verbose ? { Cache: "" } : {}),
      },
    ];
  }
  return params.recent.map((sess) => ({
    Key: params.shortenText(sess.key, 32),
    Kind: sess.kind,
    Age: sess.updatedAt && sess.age != null ? params.formatTimeAgo(sess.age) : "no activity",
    Model: sess.model ?? "unknown",
    Tokens: params.formatTokensCompact(sess),
    ...(params.verbose
      ? { Cache: params.formatPromptCacheCompact(sess) || params.muted("—") }
      : {}),
  }));
}

export function buildStatusFooterLines(params: {
  updateHint: string | null;
  warn: (value: string) => string;
  formatCliCommand: (value: string) => string;
  nodeOnlyGateway: unknown;
  gatewayReachable: boolean;
}) {
  return [
    "FAQ: https://docs.openclaw.ai/faq",
    "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
    ...(params.updateHint ? ["", params.warn(params.updateHint)] : []),
    "Next steps:",
    `  Need to share?      ${params.formatCliCommand("openclaw status --all")}`,
    `  Need to debug live? ${params.formatCliCommand("openclaw logs --follow")}`,
    params.nodeOnlyGateway
      ? `  Need node service?  ${params.formatCliCommand("openclaw node status")}`
      : params.gatewayReachable
        ? `  Need to test channels? ${params.formatCliCommand("openclaw status --deep")}`
        : `  Fix reachability first: ${params.formatCliCommand("openclaw gateway probe")}`,
  ];
}

export function buildStatusPluginCompatibilityLines<
  TNotice extends PluginCompatibilityNoticeLike,
>(params: {
  notices: TNotice[];
  limit?: number;
  formatNotice: (notice: TNotice) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  if (params.notices.length === 0) {
    return [];
  }
  const limit = params.limit ?? 8;
  return [
    ...params.notices.slice(0, limit).map((notice) => {
      const label = notice.severity === "warn" ? params.warn("WARN") : params.muted("INFO");
      return `  ${label} ${params.formatNotice(notice)}`;
    }),
    ...(params.notices.length > limit
      ? [params.muted(`  … +${params.notices.length - limit} more`)]
      : []),
  ];
}

export function buildStatusPairingRecoveryLines(params: {
  pairingRecovery: PairingRecoveryLike | null;
  warn: (value: string) => string;
  muted: (value: string) => string;
  formatCliCommand: (value: string) => string;
}) {
  if (!params.pairingRecovery) {
    return [];
  }
  return [
    params.warn("Gateway pairing approval required."),
    ...(params.pairingRecovery.requestId
      ? [
          params.muted(
            `Recovery: ${params.formatCliCommand(`openclaw devices approve ${params.pairingRecovery.requestId}`)}`,
          ),
        ]
      : []),
    params.muted(`Fallback: ${params.formatCliCommand("openclaw devices approve --latest")}`),
    params.muted(`Inspect: ${params.formatCliCommand("openclaw devices list")}`),
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
  muted: (value: string) => string;
}) {
  const limit = params.limit ?? 5;
  return params.queuedSystemEvents.length > limit
    ? params.muted(`… +${params.queuedSystemEvents.length - limit} more`)
    : null;
}
