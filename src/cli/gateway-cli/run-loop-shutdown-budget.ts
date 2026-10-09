import { performance } from "node:perf_hooks";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
  resolveShutdownReserveMs,
  resolveSupervisorExitMarginMs,
} from "../../infra/gateway-shutdown-budget.js";
import { readLaunchdStopTimeout } from "../../infra/launchd-stop-timeout.js";
import { readSystemdStopTimeout } from "../../infra/systemd-stop-timeout.js";
import type { GatewayRunSignalAction } from "./run-loop-request.js";

type NativeStopTimeout = { timeoutMs: number; source: string };

// Only an inconclusive probe may retain the startup budget; a confirmed absence
// of a native deadline must not constrain an in-process restart.
async function readNativeStopTimeout(stopping: boolean): Promise<{
  stop: NativeStopTimeout | null;
  warning?: string;
  inconclusive: boolean;
}> {
  if (process.platform === "linux") {
    const systemd = await readSystemdStopTimeout();
    return {
      stop: systemd,
      warning: systemd?.warning,
      inconclusive: !systemd || Boolean(systemd.warning),
    };
  }
  // launchd's ExitTimeOut applies only while launchd is stopping the job.
  if (process.platform === "darwin" && stopping) {
    const read = await readLaunchdStopTimeout();
    // A warned, non-null deadline confirms a stop with a defaulted timeout.
    return { ...read, inconclusive: read.stop === null && read.warning !== undefined };
  }
  return { stop: null, inconclusive: false };
}

export async function resolveGatewayShutdownBudget(
  supervisor: string | null,
  logger: { info(message: string): void; warn(message: string): void },
  refresh?: {
    previous: { timeoutMs: number; nativeStopBudget: boolean };
    acceptedAtMs: number;
  },
) {
  const native = await readNativeStopTimeout(refresh !== undefined);
  const nativeStop = native.stop;
  const retained =
    refresh?.previous.nativeStopBudget && native.inconclusive ? refresh.previous : undefined;
  if (native.warning) {
    logger.warn(native.warning);
  }
  if (retained) {
    logger.warn(
      `Retaining the startup shutdown budget of ${retained.timeoutMs}ms because the current supervisor stop timeout could not be confirmed.`,
    );
  }
  const stop = nativeStop ?? {
    timeoutMs:
      supervisor === "launchd"
        ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
        : GATEWAY_SERVICE_STOP_TIMEOUT_MS,
    source: supervisor === "launchd" ? "launchd ExitTimeOut" : "Gateway stop policy",
  };
  // ExitTimeOut=0 is unlimited. It is an observed job value, not a native
  // deadline that may cap a requested restart or arm a forced exit.
  const nativeStopBudget = nativeStop
    ? Number.isFinite(nativeStop.timeoutMs)
    : supervisor === "launchd" || Boolean(retained);
  // Scale margin and reserve to retain drain time under short native deadlines.
  const exitMarginMs = resolveSupervisorExitMarginMs(stop.timeoutMs);
  const limitMs =
    retained?.timeoutMs ?? Math.min(GATEWAY_SHUTDOWN_TIMEOUT_MS, stop.timeoutMs - exitMarginMs);
  const elapsedMs =
    refresh && nativeStopBudget
      ? Math.max(0, Math.ceil(performance.now() - refresh.acceptedAtMs))
      : 0;
  const timeoutMs = Math.max(0, limitMs - elapsedMs);
  const reserveMs = resolveShutdownReserveMs(timeoutMs);
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
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - reserveMs)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${exitMarginMs}ms; source=${retained ? `startup shutdown budget=${retained.timeoutMs}ms` : `${stop.source}=${stop.timeoutMs}ms`}`,
      );
    },
  };
}

export function resolveGatewayShutdownDrainBudget(params: {
  budget: { nativeStopBudget: boolean; timeoutMs: number; reserveMs: number };
  action: GatewayRunSignalAction;
  forceRestart: boolean;
  restartWithoutSupervisor: boolean;
  acceptedAtMs: number;
  requestedRestartDrainTimeoutMs?: number;
}) {
  const { budget, action } = params;
  const isRestart = action !== "stop";
  const requested = params.requestedRestartDrainTimeoutMs;
  const elapsedMs = performance.now() - params.acceptedAtMs;
  const remaining = requested === undefined ? undefined : Math.max(0, requested - elapsedMs);
  const restartDrainTimeoutMs = budget.nativeStopBudget
    ? Math.min(remaining ?? Infinity, Math.max(0, budget.timeoutMs - budget.reserveMs))
    : remaining;
  const restartDrainDeadlineAt =
    isRestart && restartDrainTimeoutMs !== undefined
      ? Date.now() + restartDrainTimeoutMs
      : undefined;
  const forcedRestartDeadlineAt =
    params.forceRestart && restartDrainDeadlineAt !== undefined
      ? restartDrainDeadlineAt + budget.reserveMs
      : undefined;
  const restartTimeoutMs = (drainTimeoutMs: number) => {
    if (forcedRestartDeadlineAt !== undefined) {
      return Math.max(0, forcedRestartDeadlineAt - Date.now());
    }
    // A containing service can bound an in-process restart without replacing it.
    return budget.nativeStopBudget && params.restartWithoutSupervisor
      ? budget.timeoutMs
      : drainTimeoutMs + (budget.nativeStopBudget ? budget.reserveMs : GATEWAY_SHUTDOWN_TIMEOUT_MS);
  };
  return {
    restartDrainDeadlineAt,
    restartTimeoutMs: () =>
      budget.nativeStopBudget || params.forceRestart
        ? restartTimeoutMs(Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()))
        : GATEWAY_SHUTDOWN_TIMEOUT_MS,
    closeDrainTimeoutMs: () =>
      restartDrainTimeoutMs === undefined
        ? GATEWAY_SHUTDOWN_TIMEOUT_MS - budget.reserveMs
        : Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()),
    drainTimeoutMs: isRestart
      ? restartDrainTimeoutMs
      : Math.max(0, budget.timeoutMs - budget.reserveMs),
    // A supervisor SIGTERM owns the stop deadline. Its shorter drain request
    // must not discard time still available for checkpointing and native close.
    forceExitMs:
      !isRestart || (action === "external-restart" && budget.nativeStopBudget)
        ? budget.timeoutMs
        : restartDrainTimeoutMs === undefined
          ? undefined
          : restartTimeoutMs(restartDrainTimeoutMs),
  };
}
