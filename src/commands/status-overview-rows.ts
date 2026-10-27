import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveIsNixMode } from "../config/paths.js";
import { formatMissingChildRuntimeWarning } from "../infra/child-runtime-viability.js";
import { formatDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import {
  resolveMemoryVectorState,
  resolveMemoryFtsState,
  resolveMemoryCacheSummary,
  type Tone,
} from "../memory-host-sdk/status.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { BackupRunFreshness } from "../state/backup-run-records.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import { formatTokenCount } from "../utils/token-format.js";
import { VERSION } from "../version.js";
import { buildBackupStatusValue } from "./backup-health.js";
import type { HealthSummary } from "./health.js";
import { formatRecoveryDiskUsage } from "./recovery-disk-usage.js";
import { buildStatusOverviewSurfaceRows } from "./status-all/format.js";
import { buildStatusDatabaseStoreRows } from "./status-database-engines.js";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import {
  buildStatusSecretDiagnostics,
  countActiveStatusAgents,
  formatHostDesktopStatus,
} from "./status-overview-values.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

type StatusDegradationSummary = Pick<
  StatusSummary,
  | "degradedSecretOwners"
  | "degradedPlugins"
  | "startupMigrationWarning"
  | "startupRecoveryWarning"
  | "modelReasoningWarning"
  | "installationReplacementWarning"
  | "utilityModelWarnings"
  | "childRuntime"
  | "secretEgressProxy"
  | "pluginReload"
>;

function buildStatusDegradationRows(
  summary: StatusDegradationSummary,
  decorate = (value: string) => value,
) {
  const rows: Array<{ Item: string; Value: string }> = [];
  const addWarning = (Item: string, value: string | undefined) => {
    if (value) {
      rows.push({ Item, Value: decorate(value) });
    }
  };
  addWarning("Startup migrations", summary.startupMigrationWarning);
  addWarning("Session recovery", summary.startupRecoveryWarning);
  addWarning("Model reasoning", summary.modelReasoningWarning);
  addWarning(
    "Gateway runtime",
    summary.childRuntime ? formatMissingChildRuntimeWarning(summary.childRuntime) : undefined,
  );
  addWarning("Installation replaced", summary.installationReplacementWarning);
  for (const warning of summary.utilityModelWarnings ?? []) {
    addWarning("Utility model", `${warning.path}: ${warning.message}`);
  }
  if (summary.secretEgressProxy) {
    const status = summary.secretEgressProxy;
    rows.push({
      Item: "Secret egress proxy",
      Value:
        status.state === "ready"
          ? `ready · CA expires ${status.caExpiresAt}`
          : decorate(status.message ?? "Certificate preparation unavailable"),
    });
  }
  const secretOwners = buildStatusSecretDiagnostics(summary.degradedSecretOwners ?? [], []);
  if (secretOwners.length > 0) {
    addWarning(
      "Degraded secrets",
      `${secretOwners.length} degraded · ${secretOwners.slice(0, 10).join(", ")}${secretOwners.length > 10 ? `, … +${secretOwners.length - 10} more` : ""}`,
    );
  }
  const plugins = summary.degradedPlugins ?? [];
  if (plugins.length > 0) {
    addWarning(
      "Degraded plugins",
      `${plugins.length} configured-unavailable · ${plugins.map((plugin) => plugin.pluginId).join(", ")}`,
    );
  }
  const reload = summary.pluginReload;
  if (reload) {
    addWarning(
      "Plugin reload",
      [`${reload.phase} ${reload.pluginIds.join(", ")}`, reload.reason].filter(Boolean).join(" · "),
    );
  }
  return rows;
}

export function buildStatusCommandOverviewRows(params: {
  env: NodeJS.ProcessEnv;
  backupFreshness: BackupRunFreshness;
  opts: {
    deep?: boolean;
  };
  surface: StatusOverviewSurface;
  osLabel: string;
  summary: StatusSummary;
  health?: HealthSummary;
  lastHeartbeat: HeartbeatEventPayload | null;
  agentStatus: {
    defaultId?: string | null;
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: AgentLocalStatus[];
  };
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
  updateValue?: string;
  updateRows?: Array<{ Item: string; Value: string }>;
}) {
  const pending =
    params.agentStatus.bootstrapPendingCount > 0
      ? `${params.agentStatus.bootstrapPendingCount} bootstrap file${params.agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present`
      : "no workspaces bootstrapping";
  const def = params.agentStatus.agents.find((a) => a.id === params.agentStatus.defaultId);
  const defActive = def?.lastActiveAgeMs != null ? formatTimeAgo(def.lastActiveAgeMs) : "unknown";
  const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
  const agentsValue = `${params.agentStatus.agents.length} · ${pending} · sessions ${params.agentStatus.totalSessions}${defSuffix}`;
  const eventsValue =
    params.summary.queuedSystemEvents.length > 0
      ? `${params.summary.queuedSystemEvents.length} queued`
      : "none";
  const probesValue = params.health
    ? theme.success("enabled")
    : theme.muted("skipped (use --deep)");
  const heartbeatParts = params.summary.heartbeat.agents.map((agent) => {
    if (!agent.enabled) {
      return `disabled (${agent.agentId})`;
    }
    if (agent.waitingForRoute) {
      return `${agent.every} (${agent.agentId}; waiting for delivery route — set commands.ownerAllowFrom=["telegram:123456789"] or channel allowFrom, or edit the automation delivery channel and recipient)`;
    }
    return `${agent.every} (${agent.agentId})`;
  });
  const heartbeatValue = heartbeatParts.length > 0 ? heartbeatParts.join(", ") : "disabled";
  let lastHeartbeatValue: string | null;
  if (!params.opts.deep) {
    // Fast status omits the row entirely instead of implying heartbeat is missing.
    lastHeartbeatValue = null;
  } else if (params.surface.gatewayProbe?.startupPhase) {
    lastHeartbeatValue = theme.muted(
      `not checked (gateway still starting; phase ${params.surface.gatewayProbe.startupPhase})`,
    );
  } else if (!params.surface.gatewayReachable) {
    lastHeartbeatValue = theme.warn("unavailable");
  } else if (!params.lastHeartbeat) {
    lastHeartbeatValue = theme.muted("none");
  } else {
    const age = formatTimeAgo(Date.now() - params.lastHeartbeat.ts);
    const accountLabel = params.lastHeartbeat.accountId
      ? `account ${params.lastHeartbeat.accountId}`
      : null;
    lastHeartbeatValue = [
      params.lastHeartbeat.status,
      age,
      params.lastHeartbeat.channel,
      accountLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  let memoryValue: string;
  if (!params.memoryPlugin.enabled) {
    const suffix = params.memoryPlugin.reason ? ` (${params.memoryPlugin.reason})` : "";
    memoryValue = theme.muted(`disabled${suffix}`);
  } else if (!params.memory) {
    const slot = params.memoryPlugin.slot ? `plugin ${params.memoryPlugin.slot}` : "plugin";
    memoryValue = theme.muted(`enabled (${slot}) · not checked`);
  } else if ("health" in params.memory) {
    const detail = params.memory.health.message ? ` · ${params.memory.health.message}` : "";
    const status =
      params.memory.health.status === "ready"
        ? theme.success("ready")
        : params.memory.health.status === "degraded"
          ? theme.warn("degraded")
          : theme.warn("unavailable");
    memoryValue = `plugin ${params.memory.provider} · ${status}${detail}`;
  } else {
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
    memoryValue = parts.join(" · ");
  }
  let pluginCompatibilityValue: string;
  if (params.pluginCompatibility.length === 0) {
    pluginCompatibilityValue = theme.success("none");
  } else {
    const pluginCount = new Set(params.pluginCompatibility.map((notice) => notice.pluginId)).size;
    pluginCompatibilityValue = theme.warn(
      `${params.pluginCompatibility.length} notice${params.pluginCompatibility.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`,
    );
  }
  const updatesDisabled =
    params.surface.cfg.update?.checkOnStart === false ||
    isTruthyEnvValue(params.env.OPENCLAW_NO_AUTO_UPDATE) ||
    resolveIsNixMode(params.env);
  const doNotTrack = params.env.DO_NOT_TRACK?.trim().toLowerCase();
  const telemetryValue = updatesDisabled
    ? theme.muted("disabled · update checks off")
    : doNotTrack === "1" || doNotTrack === "true"
      ? theme.muted("disabled (DO_NOT_TRACK)")
      : params.surface.cfg.telemetry?.enabled === true
        ? theme.success("enabled · anonymous feature stats")
        : theme.muted("disabled · update checks only");
  const hostDesktopValue = formatHostDesktopStatus(params.summary.hostDesktop);
  const { sessions } = params.summary;
  const defaultCtx = sessions.defaults.contextTokens
    ? ` (${formatTokenCount(sessions.defaults.contextTokens)} ctx)`
    : "";
  const storeLabel =
    sessions.paths.length > 1
      ? `${sessions.paths.length} stores`
      : (sessions.paths[0] ?? "unknown");
  return buildStatusOverviewSurfaceRows({
    ...params.surface,
    decorateOk: theme.success,
    decorateWarn: theme.warn,
    decorateTailscaleOff: theme.muted,
    decorateTailscaleWarn: theme.warn,
    prefixRows: [{ Item: "OS", Value: `${params.osLabel} · node ${process.versions.node}` }],
    updateValue: params.updateValue,
    agentsValue,
    suffixRows: [
      ...(params.updateRows ?? []),
      ...((params.surface.cfg.database || params.surface.databaseEngines?.stores.length) &&
      params.surface.databaseEngines?.source !== "unavailable"
        ? [
            {
              Item: "Database engines (configured)",
              Value: formatDatabaseEngineSelection(
                params.surface.cfg,
                params.surface.databaseEngines?.stores,
              ),
            },
          ]
        : []),
      ...buildStatusDatabaseStoreRows(params.surface.databaseEngines),
      ...(params.surface.recoveryCopies
        ? [
            {
              Item: "Recovery copies (local)",
              Value: formatRecoveryDiskUsage(params.surface.recoveryCopies),
            },
          ]
        : []),
      { Item: "Telemetry", Value: telemetryValue },
      { Item: "Memory", Value: memoryValue },
      {
        Item: "Host desktop",
        Value:
          (params.summary.hostDesktop?.state ?? "disabled") === "disabled"
            ? theme.muted(hostDesktopValue)
            : hostDesktopValue,
      },
      ...buildStatusDegradationRows(params.summary, theme.warn),
      { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
      { Item: "Checks", Value: probesValue },
      { Item: "Events", Value: eventsValue },
      {
        Item: "Backups",
        Value: buildBackupStatusValue({
          freshness: params.backupFreshness,
          formatTimeAgo,
        }),
      },
      ...(params.backupFreshness.latestOffsite
        ? [
            {
              Item: "Offsite backup",
              Value: `${params.backupFreshness.latestOffsite.location?.name ?? params.backupFreshness.latestOffsite.target}: ${buildBackupStatusValue(
                {
                  freshness: { latest: params.backupFreshness.latestOffsite },
                  formatTimeAgo,
                },
              )}`,
            },
          ]
        : []),
      { Item: "Heartbeat", Value: heartbeatValue },
      ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
      {
        Item: "Sessions",
        Value: `${sessions.count} stored · default ${sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`,
      },
    ],
    gatewayAuthWarningValue: params.surface.gatewayProbeAuthWarning
      ? theme.warn(params.surface.gatewayProbeAuthWarning)
      : null,
  });
}

export function buildStatusAllOverviewRows(params: {
  surface: StatusOverviewSurface;
  summary: StatusDegradationSummary;
  osLabel: string;
  configPath: string;
  secretDiagnosticsCount: number;
  updateRows?: Array<{ Item: string; Value: string }>;
  agentStatus: {
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: Array<{
      id: string;
      lastActiveAgeMs?: number | null;
    }>;
  };
}) {
  return buildStatusOverviewSurfaceRows({
    ...params.surface,
    includeBackendStateWhenOn: true,
    includeDnsNameWhenOff: true,
    prefixRows: [
      { Item: "Version", Value: VERSION },
      { Item: "OS", Value: params.osLabel },
      { Item: "Node", Value: process.versions.node },
      { Item: "Config", Value: params.configPath },
    ],
    middleRows: [
      ...(params.updateRows ?? []),
      { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
      ...buildStatusDegradationRows(params.summary),
    ],
    agentsValue: `${params.agentStatus.agents.length} total · ${params.agentStatus.bootstrapPendingCount} bootstrapping · ${countActiveStatusAgents({ agentStatus: params.agentStatus })} active · ${params.agentStatus.totalSessions} sessions`,
    suffixRows: [
      ...(params.surface.databaseEngines?.source !== "unavailable"
        ? [
            {
              Item: "Database engines (configured)",
              Value: formatDatabaseEngineSelection(
                params.surface.cfg,
                params.surface.databaseEngines?.stores,
              ),
            },
          ]
        : []),
      ...buildStatusDatabaseStoreRows(params.surface.databaseEngines),
      ...(params.surface.recoveryCopies
        ? [
            {
              Item: "Recovery copies (local)",
              Value: formatRecoveryDiskUsage(params.surface.recoveryCopies),
            },
          ]
        : []),
      {
        Item: "Secrets",
        Value:
          params.secretDiagnosticsCount > 0
            ? `${params.secretDiagnosticsCount} diagnostic${params.secretDiagnosticsCount === 1 ? "" : "s"}`
            : "none",
      },
    ],
    gatewaySelfFallbackValue: "unknown",
  });
}
