import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
import type { PortUsage } from "../../infra/ports.js";

export const GATEWAY_RESTART_WAIT_OUTCOMES = [
  "healthy",
  "plugin-errors",
  "plugin-unavailable",
  "channel-errors",
  "version-mismatch",
  "build-id-mismatch",
  "stale-pids",
  "stopped-free",
  "timeout",
] as const;

export type GatewayRestartWaitOutcome = (typeof GATEWAY_RESTART_WAIT_OUTCOMES)[number];

export type UnavailablePluginHealthSummary = {
  id: string;
  reason: string;
  detail: string;
};

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
  gatewayVersion?: string | null;
  gatewayBootId?: string;
  gatewayBuildId?: string | null;
  probeError?: string;
  activatedPluginErrors?: PluginHealthErrorSummary[];
  unavailablePlugins?: UnavailablePluginHealthSummary[];
  channelProbeErrors?: Array<{ id: string; error: string }>;
  expectedVersion?: string;
  versionMismatch?: {
    expected: string;
    actual: string | null;
  };
  expectedBuildId?: string;
  buildIdMismatch?: {
    expected: string;
    actual: string | null;
  };
  waitOutcome?: GatewayRestartWaitOutcome;
  elapsedMs?: number;
  startupPhase?: string;
};

export type GatewayPortHealthSnapshot = {
  portUsage: PortUsage;
  healthy: boolean;
  probeError?: string;
  activatedPluginErrors?: PluginHealthErrorSummary[];
  unavailablePlugins?: UnavailablePluginHealthSummary[];
};
