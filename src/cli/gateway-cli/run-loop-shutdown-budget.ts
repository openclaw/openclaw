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

type NativeStopTimeout = { timeoutMs: number; source: string };

/**
 * Ask whichever supervisor actually enforces the deadline on this platform.
 *
 * Three independent answers. `stop` is a deadline that may be spent as a native
 * stop budget. `warning` is what the operator needs to hear. `inconclusive` says
 * the probe could not establish an answer at all, which is the only case the
 * retained-budget safety net below is for: a read that positively determined no
 * launchd deadline governs this stop is an answer, not a failure, so retaining a
 * startup budget and warning that the timeout "could not be confirmed" would be
 * false on every in-process restart of a launchd-owned Gateway.
 */
async function readNativeStopTimeout(stopping: boolean): Promise<{
  stop: NativeStopTimeout | null;
  warning?: string;
  inconclusive: boolean;
}> {
  if (process.platform === "linux") {
    const systemd = await readSystemdStopTimeout();
    // Unchanged from the linux-only original: absent unit or warned read both
    // count as unconfirmed there.
    return {
      stop: systemd,
      warning: systemd?.warning,
      inconclusive: !systemd || Boolean(systemd.warning),
    };
  }
  // launchd's ExitTimeOut bounds a stop that launchd is running and nothing else:
  // an externally delivered SIGTERM never starts that clock, and the job outlives
  // the deadline untouched. There is no enforcing deadline to read before a stop
  // is under way, and reading one at startup would spend a launchctl print only
  // to adopt a deadline that does not govern the stop the Gateway will get.
  if (process.platform === "darwin" && stopping) {
    const read = await readLaunchdStopTimeout();
    // Warned but non-null is the defaulted-value case: launchd is confirmed to be
    // stopping the job and only its deadline had to be guessed, so a clock is
    // genuinely running and nothing needs retaining. Only a warning with no
    // deadline at all means the probe established nothing.
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
  // Restart ownership may be external while the platform supervisor still
  // enforces the stop deadline. That holds on darwin exactly as it does on linux.
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
  const nativeStopBudget = nativeStop !== null || supervisor === "launchd" || Boolean(retained);
  // An operator job may enforce a deadline far shorter than the policy these fixed
  // allowances were sized against, so each is capped at a share of what it is carved
  // from. A deadline long enough to fund them is unaffected; a short one keeps a
  // proportional drain instead of surrendering all of it to margin and reserve.
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
        // Report the drain and margin actually spent. Subtracting the unscaled
        // reserve constant here understated a short budget's drain by the amount the
        // scaled reserve gave back.
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - reserveMs)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${exitMarginMs}ms; source=${retained ? `startup shutdown budget=${retained.timeoutMs}ms` : `${stop.source}=${stop.timeoutMs}ms`}`,
      );
    },
  };
}

export function resolveGatewayShutdownDrainBudget(params: {
  budget: { nativeStopBudget: boolean; timeoutMs: number; reserveMs: number };
  isRestart: boolean;
  forceRestart: boolean;
  restartWithoutSupervisor: boolean;
  acceptedAtMs: number;
  requestedRestartDrainTimeoutMs?: number;
}) {
  const { budget, isRestart } = params;
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
    forceExitMs: !isRestart
      ? budget.timeoutMs
      : restartDrainTimeoutMs === undefined
        ? undefined
        : restartTimeoutMs(restartDrainTimeoutMs),
  };
}
