import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";

export type StatusGatewayProbeBudget = {
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
};

export function createStatusGatewayProbeBudget(timeoutMs?: number): StatusGatewayProbeBudget {
  return {
    timeoutMs,
    gatewayProbeDeadlineMs: performance.now() + (timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS),
  };
}

export function resolveStatusGatewayProbeTimeoutMs(opts: StatusGatewayProbeBudget): number {
  const remainingMs = Math.max(0, Math.ceil(opts.gatewayProbeDeadlineMs - performance.now()));
  return opts.timeoutMs === undefined ? remainingMs : Math.min(opts.timeoutMs, remainingMs);
}
