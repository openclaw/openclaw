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
  refresh?: {
    previous: { timeoutMs: number; nativeStopBudget: boolean };
    acceptedAtMs: number;
  },
) {
  // Restart ownership may be external while systemd still enforces the stop deadline.
  const systemdStop = process.platform === "linux" ? await readSystemdStopTimeout() : null;
  const retained =
    refresh?.previous.nativeStopBudget && (!systemdStop || systemdStop.warning)
      ? refresh.previous
      : undefined;
  if (systemdStop?.warning) {
    logger.warn(systemdStop.warning);
  }
  if (retained) {
    logger.warn(
      `Retaining the startup shutdown budget of ${retained.timeoutMs}ms because the current systemd stop timeout could not be confirmed.`,
    );
  }
  const stop = systemdStop ?? {
    timeoutMs:
      supervisor === "launchd"
        ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
        : GATEWAY_SERVICE_STOP_TIMEOUT_MS,
    source: supervisor === "launchd" ? "launchd ExitTimeOut" : "Gateway stop policy",
  };
  const nativeStopBudget = systemdStop !== null || supervisor === "launchd" || Boolean(retained);
  const limitMs =
    retained?.timeoutMs ??
    Math.min(GATEWAY_SHUTDOWN_TIMEOUT_MS, stop.timeoutMs - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS);
  const elapsedMs =
    refresh && nativeStopBudget
      ? Math.max(0, Math.ceil(performance.now() - refresh.acceptedAtMs))
      : 0;
  const timeoutMs = Math.max(0, limitMs - elapsedMs);
  const reserveMs = Math.min(GATEWAY_SHUTDOWN_RESERVE_MS, timeoutMs);
  return {
    nativeStopBudget,
    timeoutMs,
    reserveMs,
    // Let cleanup failures reach the run loop before its native exit timer wins.
    cleanupBudget: (deadline: number | undefined, hardExitGraceMs: number) =>
      deadline === undefined
        ? undefined
        : {
            deadline:
              deadline -
              Math.min(hardExitGraceMs / 2, Math.max(0, deadline - performance.now()) / 2),
            warn: (message: string) => logger.warn(message),
          },
    log: (phase: "startup" | "shutdown") => {
      logger.info(
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - GATEWAY_SHUTDOWN_RESERVE_MS)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${GATEWAY_SUPERVISOR_EXIT_MARGIN_MS}ms; source=${retained ? `startup shutdown budget=${retained.timeoutMs}ms` : `${stop.source}=${stop.timeoutMs}ms`}`,
      );
    },
  };
}

export function resolveGatewayShutdownDrainBudget(params: {
  budget: { nativeStopBudget: boolean; timeoutMs: number; reserveMs: number };
  isRestart: boolean;
  restartWithoutSupervisor: boolean;
  requestedRestartDrainTimeoutMs?: number;
}) {
  const { budget, isRestart } = params;
  const requested = params.requestedRestartDrainTimeoutMs;
  const restartDrainTimeoutMs = budget.nativeStopBudget
    ? Math.min(requested ?? Infinity, Math.max(0, budget.timeoutMs - budget.reserveMs))
    : requested;
  const restartDrainDeadlineAt =
    isRestart && restartDrainTimeoutMs !== undefined
      ? Date.now() + restartDrainTimeoutMs
      : undefined;
  const restartTimeoutMs = (drainTimeoutMs: number) =>
    // A containing service can bound an in-process restart without replacing it.
    budget.nativeStopBudget && params.restartWithoutSupervisor
      ? budget.timeoutMs
      : drainTimeoutMs + (budget.nativeStopBudget ? budget.reserveMs : GATEWAY_SHUTDOWN_TIMEOUT_MS);
  return {
    restartDrainDeadlineAt,
    restartTimeoutMs: () =>
      budget.nativeStopBudget
        ? restartTimeoutMs(Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()))
        : GATEWAY_SHUTDOWN_TIMEOUT_MS,
    closeDrainTimeoutMs: () =>
      restartDrainTimeoutMs === undefined
        ? GATEWAY_SHUTDOWN_TIMEOUT_MS - budget.reserveMs
        : Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()),
    drainTimeoutMs: isRestart
      ? restartDrainTimeoutMs
      : Math.max(0, budget.timeoutMs - budget.reserveMs),
    forceExitMs: !isRestart
      ? budget.timeoutMs
      : restartDrainTimeoutMs === undefined
        ? undefined
        : restartTimeoutMs(restartDrainTimeoutMs),
  };
}
