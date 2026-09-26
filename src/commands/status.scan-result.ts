// Normalized full status scan result shape.
// Builders flatten the gateway snapshot so downstream text/JSON code reads one stable object.

import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import type { AgentLocalStatusesResult } from "./status.agent-local.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

type StatusScanGatewayResult = Omit<
  StatusScanOverviewResult["gatewaySnapshot"],
  "gatewayCallOverrides"
>;

type StatusJsonAgentStatuses = Omit<
  AgentLocalStatusesResult,
  "ownership" | "selectionRequired" | "bootstrapPendingCount"
> & {
  ownership: AgentLocalStatusesResult["ownership"] | null;
  selectionRequired: boolean | null;
  bootstrapPendingCount: number | null;
};

export type StatusScanResult<
  AgentStatus extends StatusJsonAgentStatuses = AgentLocalStatusesResult,
> = Omit<
  StatusScanOverviewResult,
  | "coldStart"
  | "hasConfiguredChannels"
  | "skipColdStartNetworkChecks"
  | "gatewaySnapshot"
  | "channelsStatus"
  | "runtimeDegradation"
  | "sessionStores"
  | "agentStatus"
> &
  StatusScanGatewayResult & {
    summary: StatusSummary;
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
    agentStatus: AgentStatus;
    collection?: {
      source: "gateway";
      notCollected: Array<{ fields: string[]; reason: string }>;
    };
  };

export type StatusJsonScanResult = StatusScanResult<StatusJsonAgentStatuses>;

/** Flattens overview, gateway, channel, summary, memory, and compatibility inputs into a scan result. */
export function buildStatusScanResult<
  AgentStatus extends StatusJsonAgentStatuses = AgentLocalStatusesResult,
>(
  params: Omit<StatusScanResult<AgentStatus>, keyof StatusScanGatewayResult> & {
    gatewaySnapshot: StatusScanGatewayResult;
  },
): StatusScanResult<AgentStatus> {
  const { gatewaySnapshot, advertisedControlUiLinks, ...result } = params;
  return {
    ...result,
    ...(advertisedControlUiLinks ? { advertisedControlUiLinks } : {}),
    gatewayConnection: gatewaySnapshot.gatewayConnection,
    remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
    gatewayMode: gatewaySnapshot.gatewayMode,
    gatewayProbeAuth: gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: gatewaySnapshot.gatewayProbeAuthWarning,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    gatewaySelf: gatewaySnapshot.gatewaySelf,
  };
}
