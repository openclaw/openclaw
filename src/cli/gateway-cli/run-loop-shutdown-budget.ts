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

// Only an inconclusive probe may retain the startup budget; a confirmed absence
// of a native deadline must not constrain an in-process restart.
async function readNativeStopTimeout(stopping: boolean) {
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
