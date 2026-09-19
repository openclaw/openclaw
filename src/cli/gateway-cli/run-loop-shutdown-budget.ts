import { performance } from "node:perf_hooks";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "../../infra/gateway-shutdown-budget.js";
import { readSystemdStopTimeout } from "../../infra/systemd-stop-timeout.js";

export async function resolveGatewayShutdownBudget(
  supervisor: string | null,
  logger: { info(message: string): void; warn(message: string): void },
) {
  // Restart ownership may be external while systemd still enforces the stop deadline.
  const systemdStop = process.platform === "linux" ? await readSystemdStopTimeout() : null;
  if (systemdStop?.warning) {
    logger.warn(systemdStop.warning);
  }
  const stop = systemdStop ?? {
    timeoutMs:
      supervisor === "launchd"
        ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
        : GATEWAY_SERVICE_STOP_TIMEOUT_MS,
    source: supervisor === "launchd" ? "launchd ExitTimeOut" : "Gateway stop policy",
  };
  const timeoutMs = Math.max(
    0,
    Math.min(GATEWAY_SHUTDOWN_TIMEOUT_MS, stop.timeoutMs - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS),
  );
  const reserveMs = Math.min(GATEWAY_SHUTDOWN_RESERVE_MS, timeoutMs);
  return {
    nativeStopBudget: systemdStop !== null || supervisor === "launchd",
    timeoutMs,
    reserveMs,
    // Let cleanup failures reach the run loop before its native exit timer wins.
    cleanupDeadline: (deadline: number, hardExitGraceMs: number) =>
      deadline - Math.min(hardExitGraceMs / 2, Math.max(0, deadline - performance.now()) / 2),
    log: (phase: "startup" | "shutdown") => {
      logger.info(
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - GATEWAY_SHUTDOWN_RESERVE_MS)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${GATEWAY_SUPERVISOR_EXIT_MARGIN_MS}ms; source=${stop.source}=${stop.timeoutMs}ms`,
      );
    },
  };
}
