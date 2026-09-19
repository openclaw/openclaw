import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";

export function resolveStatusGatewayProbeTimeoutMs(opts: {
  timeoutMs?: number;
  gatewayProbeDeadlineMs?: number;
}): number {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS;
  return opts.gatewayProbeDeadlineMs === undefined
    ? timeoutMs
    : Math.min(timeoutMs, Math.max(0, Math.ceil(opts.gatewayProbeDeadlineMs - performance.now())));
}
