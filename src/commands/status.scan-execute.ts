import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { buildStatusScanResult, type StatusScanResult } from "./status.scan-result.ts";
import {
  resolveMemoryPluginStatus,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";

/**
 * Completes a status scan from the shared overview result by resolving memory
 * and summary data, then packaging the legacy scan result shape.
 */
export async function executeStatusScanFromOverview(params: {
  overview: StatusScanOverviewResult;
  runtime?: RuntimeEnv;
  summary?: {
    includeChannelSummary?: boolean;
  };
  resolveMemory: (args: {
    cfg: StatusScanOverviewResult["cfg"];
    agentStatus: StatusScanOverviewResult["agentStatus"];
    memoryPlugin: MemoryPluginStatus;
    runtime?: RuntimeEnv;
  }) => Promise<MemoryStatusSnapshot | null>;
  channelIssues: StatusScanResult["channelIssues"];
  channels: StatusScanResult["channels"];
  pluginCompatibility: PluginCompatibilityNotice[];
}) {
  const memoryPlugin = resolveMemoryPluginStatus(params.overview.cfg);
  // Memory and summary collection are independent; keep them parallel so deep
  // status does not serialize disk-backed memory work with summary assembly.
  const [memory, summary] = await Promise.all([
    params.resolveMemory({
      cfg: params.overview.cfg,
      agentStatus: params.overview.agentStatus,
      memoryPlugin,
      ...(params.runtime ? { runtime: params.runtime } : {}),
    }),
    resolveStatusSummaryFromOverview({
      overview: params.overview,
      includeChannelSummary: params.summary?.includeChannelSummary,
    }),
  ]);

  return buildStatusScanResult({
    cfg: params.overview.cfg,
    sourceConfig: params.overview.sourceConfig,
    secretDiagnostics: params.overview.secretDiagnostics,
    osSummary: params.overview.osSummary,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    update: params.overview.update,
    gatewaySnapshot: params.overview.gatewaySnapshot,
    channelIssues: params.channelIssues,
    agentStatus: params.overview.agentStatus,
    channels: params.channels,
    summary,
    memory,
    memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
  });
}
