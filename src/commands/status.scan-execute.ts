// Converts a shared status overview scan into the full status scan result.
// Memory and summary collection run in parallel after the common gateway/config scan has completed.

import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { resolveMemoryPluginStatus, type MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { buildStatusScanResult } from "./status.scan-result.ts";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

/** Builds a full status scan result from an overview scan plus channel/plugin compatibility data. */
export async function executeStatusScanFromOverview(params: {
  overview: StatusScanOverviewResult;
  resolveMemory: (args: {
    cfg: StatusScanOverviewResult["cfg"];
    agentStatus: StatusScanOverviewResult["agentStatus"];
    memoryPlugin: MemoryPluginStatus;
  }) => Promise<MemoryStatusSnapshot | null>;
  pluginCompatibility: PluginCompatibilityNotice[];
}) {
  const memoryPlugin = resolveMemoryPluginStatus(params.overview.cfg);
  // Memory probing can hit disk/plugin code, so run it alongside session/task summary collection.
  const [memory, summary] = await Promise.all([
    params.resolveMemory({
      cfg: params.overview.cfg,
      agentStatus: params.overview.agentStatus,
      memoryPlugin,
    }),
    resolveStatusSummaryFromOverview({ overview: params.overview }),
  ]);

  return buildStatusScanResult({
    env: params.overview.env ?? {},
    cfg: params.overview.cfg,
    sourceConfig: params.overview.sourceConfig,
    configDiagnostics: params.overview.configDiagnostics,
    secretDiagnostics: params.overview.secretDiagnostics,
    osSummary: params.overview.osSummary,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    ...(params.overview.advertisedControlUiLinks
      ? { advertisedControlUiLinks: params.overview.advertisedControlUiLinks }
      : {}),
    update: params.overview.update,
    gatewaySnapshot: params.overview.gatewaySnapshot,
    channelIssues: params.overview.channelIssues,
    agentStatus: params.overview.agentStatus,
    channels: params.overview.channels,
    summary,
    memory,
    memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
  });
}
