import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import { type StatusOverviewSurface } from "./status-overview-surface.ts";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.js";

export async function buildStatusCommandReportData(params: {
  opts: {
    deep?: boolean;
    verbose?: boolean;
  };
  surface: StatusOverviewSurface;
  osSummary: { label: string };
  summary: {
    tasks: {
      total: number;
      active: number;
      failures: number;
      byStatus: { queued: number; running: number };
    };
    taskAudit: {
      errors: number;
      warnings: number;
    };
    heartbeat: {
      agents: Array<{
        agentId: string;
        enabled?: boolean | null;
        everyMs?: number | null;
        every: string;
      }>;
    };
    queuedSystemEvents: string[];
    sessions: {
      count: number;
      paths: string[];
      defaults: {
        model?: string | null;
        contextTokens?: number | null;
      };
      recent: Array<{
        key: string;
        kind: string;
        updatedAt?: number | null;
        age: number;
        model?: string | null;
      }>;
    };
  };
  securityAudit: {
    summary: { critical: number; warn: number; info: number };
    findings: Array<{
      severity: "critical" | "warn" | "info";
      title: string;
      detail: string;
      remediation?: string | null;
    }>;
  };
  health?: unknown;
  usageLines?: string[];
  lastHeartbeat: unknown;
  agentStatus: {
    defaultId?: string | null;
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: Array<{
      id: string;
      lastActiveAgeMs?: number | null;
    }>;
  };
  channels: {
    rows: Array<{
      id: string;
      label: string;
      enabled: boolean;
      state: "ok" | "warn" | "off" | "setup";
      detail: string;
    }>;
  };
  channelIssues: Array<{
    channel: string;
    message: string;
  }>;
  memory: {
    files: number;
    chunks: number;
    dirty?: boolean;
    sources?: string[];
    vector?: unknown;
    fts?: unknown;
    cache?: unknown;
  } | null;
  memoryPlugin: {
    enabled: boolean;
    reason?: string | null;
    slot?: string | null;
  };
  pluginCompatibility: Array<{ severity?: "warn" | "info" | null } & Record<string, unknown>>;
  pairingRecovery: { requestId: string | null } | null;
  tableWidth: number;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
  shortenText: (value: string, maxLen: number) => string;
  formatCliCommand: (value: string) => string;
  formatTimeAgo: (ageMs: number) => string;
  formatKTokens: (value: number) => string;
  formatTokensCompact: (value: {
    key: string;
    kind: string;
    updatedAt?: number | null;
    age: number;
    model?: string | null;
  }) => string;
  formatPromptCacheCompact: (value: {
    key: string;
    kind: string;
    updatedAt?: number | null;
    age: number;
    model?: string | null;
  }) => string | null;
  formatHealthChannelLines: (summary: unknown, opts: { accountMode: "all" }) => string[];
  formatPluginCompatibilityNotice: (notice: Record<string, unknown>) => string;
  formatUpdateAvailableHint: (update: Record<string, unknown>) => string | null;
  resolveMemoryVectorState: (value: unknown) => { state: string; tone: "ok" | "warn" | "muted" };
  resolveMemoryFtsState: (value: unknown) => { state: string; tone: "ok" | "warn" | "muted" };
  resolveMemoryCacheSummary: (value: unknown) => { text: string; tone: "ok" | "warn" | "muted" };
  accentDim: (value: string) => string;
  updateValue?: string;
  theme: {
    heading: (value: string) => string;
    muted: (value: string) => string;
    warn: (value: string) => string;
    error: (value: string) => string;
  };
  renderTable: (input: {
    width: number;
    columns: Array<Record<string, unknown>>;
    rows: Array<Record<string, string>>;
  }) => string;
}) {
  const overviewRows = buildStatusCommandOverviewRows({
    opts: params.opts,
    surface: params.surface,
    osLabel: params.osSummary.label,
    summary: params.summary,
    health: params.health,
    lastHeartbeat: params.lastHeartbeat,
    agentStatus: params.agentStatus,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
    ok: params.ok,
    warn: params.warn,
    muted: params.muted,
    formatTimeAgo: params.formatTimeAgo,
    formatKTokens: params.formatKTokens,
    resolveMemoryVectorState: params.resolveMemoryVectorState,
    resolveMemoryFtsState: params.resolveMemoryFtsState,
    resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    updateValue: params.updateValue,
  });

  const sessionsColumns = [
    { key: "Key", header: "Key", minWidth: 20, flex: true },
    { key: "Kind", header: "Kind", minWidth: 6 },
    { key: "Age", header: "Age", minWidth: 9 },
    { key: "Model", header: "Model", minWidth: 14 },
    { key: "Tokens", header: "Tokens", minWidth: 16 },
    ...(params.opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
  ];
  return {
    heading: params.theme.heading,
    muted: params.theme.muted,
    renderTable: params.renderTable,
    width: params.tableWidth,
    overviewRows,
    showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
    taskMaintenanceHint: `Task maintenance: ${params.formatCliCommand("openclaw tasks maintenance --apply")}`,
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      notices: params.pluginCompatibility,
      formatNotice: params.formatPluginCompatibilityNotice,
      warn: params.theme.warn,
      muted: params.theme.muted,
    }),
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      pairingRecovery: params.pairingRecovery,
      warn: params.theme.warn,
      muted: params.theme.muted,
      formatCliCommand: params.formatCliCommand,
    }),
    securityAuditLines: buildStatusSecurityAuditLines({
      securityAudit: params.securityAudit,
      theme: params.theme,
      shortenText: params.shortenText,
      formatCliCommand: params.formatCliCommand,
    }),
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      rows: params.channels.rows,
      channelIssues: params.channelIssues,
      ok: params.ok,
      warn: params.warn,
      muted: params.muted,
      accentDim: params.accentDim,
      formatIssueMessage: (message) => params.shortenText(message, 84),
    }),
    sessionsColumns,
    sessionsRows: buildStatusSessionsRows({
      recent: params.summary.sessions.recent,
      verbose: params.opts.verbose,
      shortenText: params.shortenText,
      formatTimeAgo: params.formatTimeAgo,
      formatTokensCompact: params.formatTokensCompact,
      formatPromptCacheCompact: params.formatPromptCacheCompact,
      muted: params.muted,
    }),
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      queuedSystemEvents: params.summary.queuedSystemEvents,
      muted: params.muted,
    }),
    healthColumns: params.health ? statusHealthColumns : undefined,
    healthRows: params.health
      ? buildStatusHealthRows({
          health: params.health as never,
          formatHealthChannelLines: params.formatHealthChannelLines as never,
          ok: params.ok,
          warn: params.warn,
          muted: params.muted,
        })
      : undefined,
    usageLines: params.usageLines,
    footerLines: buildStatusFooterLines({
      updateHint: params.formatUpdateAvailableHint(params.surface.update),
      warn: params.theme.warn,
      formatCliCommand: params.formatCliCommand,
      nodeOnlyGateway: params.surface.nodeOnlyGateway,
      gatewayReachable: params.surface.gatewayReachable,
    }),
  };
}
