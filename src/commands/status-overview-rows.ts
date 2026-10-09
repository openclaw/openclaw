import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveIsNixMode } from "../config/paths.js";
import { formatMissingChildRuntimeWarning } from "../infra/child-runtime-viability.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { BackupRunFreshness } from "../state/backup-run-records.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import { VERSION } from "../version.js";
import { buildBackupStatusValue } from "./backup-health.js";
import type { HealthSummary } from "./health.js";
import { buildStatusOverviewSurfaceRows } from "./status-all/format.js";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import {
  buildStatusAllAgentsValue,
  buildStatusEventsValue,
  buildStatusPluginCompatibilityValue,
  buildStatusProbesValue,
  buildStatusSecretsValue,
  buildStatusSessionsOverviewValue,
  formatHostDesktopStatus,
} from "./status-overview-values.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import {
  buildStatusAgentsValue,
  buildStatusHeartbeatValue,
  buildStatusLastHeartbeatValue,
  buildStatusMemoryValue,
} from "./status.command-sections.js";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

type StatusDegradationSummary = Pick<
  StatusSummary,
  | "degradedSecretOwners"
  | "degradedPlugins"
  | "startupMigrationWarning"
  | "startupRecoveryWarning"
  | "installationReplacementWarning"
  | "childRuntime"
  | "secretEgressProxy"
>;

function buildStatusDegradationRows(
  summary: StatusDegradationSummary,
  decorate = (value: string) => value,
) {
  const rows: Array<{ Item: string; Value: string }> = [];
  if (summary.startupMigrationWarning) {
    rows.push({ Item: "Startup migrations", Value: decorate(summary.startupMigrationWarning) });
  }
  if (summary.startupRecoveryWarning) {
    rows.push({ Item: "Session recovery", Value: decorate(summary.startupRecoveryWarning) });
  }
  const childRuntimeWarning = summary.childRuntime
    ? formatMissingChildRuntimeWarning(summary.childRuntime)
    : undefined;
  if (childRuntimeWarning) {
    rows.push({ Item: "Gateway runtime", Value: decorate(childRuntimeWarning) });
  }
  if (summary.installationReplacementWarning) {
    rows.push({
      Item: "Installation replaced",
      Value: decorate(summary.installationReplacementWarning),
    });
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
  const secretOwners = summary.degradedSecretOwners ?? [];
  if (secretOwners.length > 0) {
    rows.push({
      Item: "Degraded secrets",
      Value: decorate(
        `${secretOwners.length} degraded · ${secretOwners.map((owner) => `${owner.ownerKind}:${owner.ownerId}`).join(", ")}`,
      ),
    });
  }
  const plugins = summary.degradedPlugins ?? [];
  if (plugins.length > 0) {
    rows.push({
      Item: "Degraded plugins",
      Value: decorate(
        `${plugins.length} configured-unavailable · ${plugins.map((plugin) => plugin.pluginId).join(", ")}`,
      ),
    });
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
  const agentsValue = buildStatusAgentsValue({
    agentStatus: params.agentStatus,
  });
  const eventsValue = buildStatusEventsValue({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
  const probesValue = buildStatusProbesValue({
    health: params.health,
  });
  const heartbeatValue = buildStatusHeartbeatValue({ summary: params.summary });
  const lastHeartbeatValue = buildStatusLastHeartbeatValue({
    deep: params.opts.deep,
    gatewayReachable: params.surface.gatewayReachable,
    gatewayStartupPhase: params.surface.gatewayProbe?.startupPhase,
    lastHeartbeat: params.lastHeartbeat,
  });
  const memoryValue = buildStatusMemoryValue({
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    memoryUnavailableLabel: "not checked",
  });
  const pluginCompatibilityValue = buildStatusPluginCompatibilityValue({
    notices: params.pluginCompatibility,
  });
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
        Value: buildStatusSessionsOverviewValue({
          sessions: params.summary.sessions,
        }),
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
    agentsValue: buildStatusAllAgentsValue({
      agentStatus: params.agentStatus,
    }),
    suffixRows: [
      {
        Item: "Secrets",
        Value: buildStatusSecretsValue(params.secretDiagnosticsCount),
      },
    ],
    gatewaySelfFallbackValue: "unknown",
  });
}
