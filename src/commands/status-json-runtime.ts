// Keeps gateway health, usage, security audit, and service summaries behind explicit option gates.

import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import {
  buildGatewayStatusJsonPayload,
  resolveStatusUpdateChannelInfo,
} from "./status-all/format.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import {
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import type { StatusJsonScanResult } from "./status.scan-result.ts";

export async function resolveStatusJsonOutput(params: {
  scan: StatusJsonScanResult;
  opts: StatusGatewayProbeBudget & {
    deep?: boolean;
    usage?: boolean;
    agent?: string;
  };
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
}) {
  const { scan, opts } = params;
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
      includeSecurityAudit: params.includeSecurityAudit && !scan.collection,
      suppressHealthErrors: params.suppressHealthErrors,
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
  const surface: StatusOverviewSurface = {
    ...scan,
    gatewayService,
    nodeService,
    databaseEngines,
  };
  const projectedSecurityAudit =
    params.includeSecurityAudit && scan.collection
      ? { collected: false, reason: inspectionReason }
      : securityAudit;
  const pluginCompatibility = params.includePluginCompatibility
    ? scan.pluginCompatibility
    : undefined;
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: surface.cfg.update?.channel,
    update: surface.update,
  });
  const databaseFamilies = describeDatabaseEngineSelection(surface.cfg, databaseEngines.stores);
  const payload = {
    ...scan.summary,
    os: scan.osSummary,
    update: surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    databaseEngines: {
      experimental: databaseFamilies.some((family) => family.effective === "postgres"),
      families: databaseFamilies,
      ...databaseEngines,
    },
    gateway: buildGatewayStatusJsonPayload(surface),
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
  const backups = await readBackupRunFreshness(scan.env ?? {});
  if (backups.latest || backups.latestOk) {
    Object.assign(payload, { backups });
  }
  return {
    ...payload,
    ...(scan.collection
      ? {
          collection: {
            ...scan.collection,
            notCollected: [
              ...scan.collection.notCollected,
              ...(params.includeSecurityAudit
                ? [{ fields: ["securityAudit"], reason: inspectionReason }]
                : []),
            ],
          },
          ...(params.includePluginCompatibility
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
  };
}
