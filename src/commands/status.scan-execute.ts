// Converts a shared status overview scan into the full status scan result.
// Memory and summary collection run in parallel after the common gateway/config scan has completed.

import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { resolveMemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { buildStatusScanResult } from "./status.scan-result.ts";

/** Builds a full status scan result from an overview scan plus channel/plugin compatibility data. */
export async function executeStatusScanFromOverview(params: {
  overview: StatusScanOverviewResult;
  includeMemory?: boolean;
  pluginCompatibility: PluginCompatibilityNotice[];
}) {
  const {
    coldStart: _coldStart,
    hasConfiguredChannels: _hasConfiguredChannels,
    skipColdStartNetworkChecks: _skipColdStartNetworkChecks,
    channelsStatus: _channelsStatus,
    runtimeDegradation: _runtimeDegradation,
    sessionStores: _sessionStores,
    ...overview
  } = params.overview;
  const memoryPlugin = resolveMemoryPluginStatus(overview.cfg);
  // Memory probing can hit disk/plugin code, so run it alongside session/task summary collection.
  const [memory, summary] = await Promise.all([
    params.includeMemory
      ? import("./status.scan-memory.js").then(
          ({ resolveDefaultMemoryDatabasePath, resolveStatusMemoryStatusSnapshot }) =>
            resolveStatusMemoryStatusSnapshot({
              cfg: overview.cfg,
              agentStatus: overview.agentStatus,
              memoryPlugin,
              requireDefaultDatabasePath: resolveDefaultMemoryDatabasePath,
            }),
        )
      : null,
    resolveStatusSummaryFromOverview({ overview: params.overview }),
  ]);

  return buildStatusScanResult({
    ...overview,
    env: overview.env ?? {},
    summary,
    memory,
    memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
  });
}
