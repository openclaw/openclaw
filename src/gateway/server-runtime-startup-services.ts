import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";

export type GatewayChannelManager = Parameters<
  typeof startChannelHealthMonitor
>[0]["channelManager"];

/** Starts channel health monitoring unless process configuration suppresses channels. */
export function startGatewayChannelHealthMonitor(params: {
  channelManager: GatewayChannelManager;
  scheduler: GatewayScheduler;
  env?: NodeJS.ProcessEnv;
}): ChannelHealthMonitor | null {
  // Process-level channel suppression also owns recovery: otherwise the health
  // monitor restarts configured transports after the startup grace period.
  if (isChannelStartupSuppressedByEnvironment(params.env)) {
    return null;
  }
  return startChannelHealthMonitor({
    scheduler: params.scheduler,
    channelManager: params.channelManager,
  });
}
