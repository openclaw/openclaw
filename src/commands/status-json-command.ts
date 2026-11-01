import { projectGatewayUrlForDiagnostics } from "../gateway/connection-details.js";
import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { readUpdateRunStatus } from "../infra/update-run-status.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import { collectRecoveryDiskUsage } from "./recovery-disk-usage.js";
import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import {
  reportStatusScanFailure,
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";

type StatusJsonCommandOptions = {
  deep?: boolean;
  usage?: boolean;
  agent?: string;
  timeoutMs?: number;
  all?: boolean;
};

/** Prevents --agent from implying that the aggregate status report itself is agent-scoped. */
export function assertStatusUsageAgentScope(opts: StatusJsonCommandOptions): void {
  if (opts.agent !== undefined && opts.usage !== true) {
    throw new Error("--agent is only valid with --usage");
  }
}

export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions & StatusGatewayProbeBudget;
  runtime: RuntimeEnv;
}) {
  const { opts } = params;
  assertStatusUsageAgentScope(opts);
  let scan = await import("./status.scan.fast-json.js")
    .then(({ scanStatusJsonFast }) =>
      scanStatusJsonFast(
        {
          timeoutMs: opts.timeoutMs,
          gatewayProbeDeadlineMs: opts.gatewayProbeDeadlineMs,
          all: opts.all,
        },
        params.runtime,
      ),
    )
    .catch((error: unknown) => reportStatusScanFailure(error, params.runtime, opts.timeoutMs));
  const updateRunStatus = await readUpdateRunStatus();
  const includeSecurityAudit = opts.all === true || opts.deep === true;
  const inspectionReason = "Local plugin inspection is not collected in online status.";
  const { securityAudit, usage, health, lastHeartbeat, gatewayService, nodeService } =
    await resolveStatusRuntimeSnapshot({
      config: scan.cfg,
      sourceConfig: scan.sourceConfig,
      timeoutMs: opts.timeoutMs,
      gatewayProbeDeadlineMs: opts.gatewayProbeDeadlineMs,
      ...(opts.agent ? { agentId: opts.agent } : {}),
      usage: opts.usage,
      deep: opts.deep,
      gatewayReachable: scan.gatewayReachable,
      ...(scan.gatewayProbe?.startupPhase
        ? { gatewayStartupPhase: scan.gatewayProbe.startupPhase }
        : {}),
      ...(scan.gatewayProbe?.error ? { gatewayProbeError: scan.gatewayProbe.error } : {}),
      includeSecurityAudit: includeSecurityAudit && !scan.collection,
      suppressHealthErrors: true,
      ...(scan.collection && opts.usage
        ? {
            resolveUsage: async (input: Parameters<typeof resolveStatusUsageSummary>[0]) => {
              const { readConfigFileSnapshot, setAppliedRuntimeConfigSnapshot } =
                await import("../config/config.js");
              const snapshot = await readConfigFileSnapshot({
                observe: false,
                pluginValidation: "core-only",
              });
              await setAppliedRuntimeConfigSnapshot(snapshot.runtimeConfig, snapshot.sourceConfig);
              return resolveStatusUsageSummary({ ...input, config: snapshot.runtimeConfig });
            },
          }
        : {}),
    });

  const databaseEngines = await resolveStatusDatabaseEngines(scan.cfg, scan.summary.databaseStores);
  const backups = await readBackupRunFreshness(scan.env ?? {});
  scan = { ...scan, ...scan.publish?.() };
  const surface: StatusOverviewSurface = {
    ...scan,
    gatewayService,
    nodeService,
    databaseEngines,
  };
  const projectedSecurityAudit =
    includeSecurityAudit && scan.collection
      ? { collected: false, reason: inspectionReason }
      : securityAudit;
  const pluginCompatibility = opts.all === true ? scan.pluginCompatibility : undefined;
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: surface.cfg.update?.channel,
    update: surface.update,
  });
  const databaseFamilies = describeDatabaseEngineSelection(surface.cfg, databaseEngines.stores);
  const payload = {
    ...scan.summary,
    recoveryCopies:
      scan.recoveryCopies ??
      collectRecoveryDiskUsage({ cfg: scan.cfg, env: scan.env ?? process.env }),
    os: scan.osSummary,
    update: surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    databaseEngines: {
      // All selectable engine/search features are supported; deployment qualification is separate.
      experimental: false,
      families: databaseFamilies,
      ...databaseEngines,
    },
    gateway: {
      mode: surface.gatewayMode,
      url: projectGatewayUrlForDiagnostics(surface.gatewayConnection.url),
      urlSource: surface.gatewayConnection.urlSource,
      misconfigured: surface.remoteUrlMissing,
      reachable: surface.gatewayReachable,
      ...(surface.gatewayProbe?.startupPhase
        ? { readiness: "still-starting", startupPhase: surface.gatewayProbe.startupPhase }
        : {}),
      connectLatencyMs: surface.gatewayProbe?.connectLatencyMs ?? null,
      self: surface.gatewaySelf ?? null,
      error: surface.gatewayProbe?.error ?? null,
      authWarning: surface.gatewayProbeAuthWarning ?? null,
    },
    gatewayService: surface.gatewayService,
    nodeService: surface.nodeService,
    agents: scan.agentStatus,
    ...(scan.configDiagnostics ? { configDiagnostics: scan.configDiagnostics } : {}),
    secretDiagnostics: scan.secretDiagnostics,
    ...(projectedSecurityAudit ? { securityAudit: projectedSecurityAudit } : {}),
    ...(pluginCompatibility
      ? {
          // Keep warnings grouped with a count so consumers can test compatibility status cheaply.
          pluginCompatibility: {
            count: pluginCompatibility.length,
            warnings: pluginCompatibility,
          },
        }
      : {}),
    ...(health || usage || lastHeartbeat
      ? {
          // Deep/usage fields stay absent in fast mode instead of appearing as null placeholders.
          health,
          usage,
          lastHeartbeat,
        }
      : {}),
  };
  if (backups.latest || backups.latestOk) {
    Object.assign(payload, { backups });
  }
  writeRuntimeJson(params.runtime, {
    ...payload,
    ...(scan.collection
      ? {
          collection: {
            ...scan.collection,
            notCollected: [
              ...scan.collection.notCollected,
              ...(includeSecurityAudit
                ? [{ fields: ["securityAudit"], reason: inspectionReason }]
                : []),
            ],
          },
          ...(opts.all === true
            ? {
                pluginCompatibility: {
                  count: 0,
                  warnings: [],
                  collected: false,
                  reason: inspectionReason,
                },
              }
            : {}),
        }
      : {}),
    ...(Object.keys(updateRunStatus).length ? { updateRunStatus } : {}),
  });
}
