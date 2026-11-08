import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";

/** Starts channel health monitoring unless process configuration suppresses channels. */
export function startGatewayChannelHealthMonitor(params: {
  channelManager: Parameters<typeof startChannelHealthMonitor>[0]["channelManager"];
  scheduler: GatewayScheduler;
}): ChannelHealthMonitor | null {
  // Process-level channel suppression also owns recovery: otherwise the health
  // monitor restarts configured transports after the startup grace period.
  if (isChannelStartupSuppressedByEnvironment()) {
    return null;
  }
  return startChannelHealthMonitor({
    scheduler: params.scheduler,
    channelManager: params.channelManager,
  });
}
