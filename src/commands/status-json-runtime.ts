// Resolves runtime-only inputs for status JSON after the fast scan completes.
// Keeps gateway health, usage, security audit, and service summaries behind explicit option gates.

import { readBackupRunFreshness } from "../state/backup-run-records.js";
import { buildStatusJsonPayload } from "./status-json-payload.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import {
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import type { StatusJsonScanResult } from "./status.scan-result.ts";

/** Builds the status JSON object from a completed scan plus optional runtime/deep probes. */
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
              const { readConfigFileSnapshot } = await import("../config/config.js");
              const snapshot = await readConfigFileSnapshot({
                observe: false,
                pluginValidation: "core-only",
              });
              return resolveStatusUsageSummary({ ...input, config: snapshot.runtimeConfig });
            },
          }
        : {}),
    });

  const payload = buildStatusJsonPayload({
    summary: scan.summary,
    surface: buildStatusOverviewSurfaceFromScan({
      scan,
      gatewayService,
      nodeService,
    }),
    osSummary: scan.osSummary,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    agents: scan.agentStatus,
    configDiagnostics: scan.configDiagnostics,
    secretDiagnostics: scan.secretDiagnostics,
    securityAudit:
      params.includeSecurityAudit && scan.collection
        ? { collected: false, reason: inspectionReason }
        : securityAudit,
    health,
    usage,
    lastHeartbeat,
    pluginCompatibility: params.includePluginCompatibility ? scan.pluginCompatibility : undefined,
  });
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
