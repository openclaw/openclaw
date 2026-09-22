import {
  markGatewayRestartTrace,
  measureGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayDrainReason } from "../../process/gateway-work-admission.js";
import type { GatewayRunSignalAction, GatewayRunSignalRequest } from "./run-loop-request.js";
import { formatDrainCounts, formatShutdownReason } from "./run-loop-shutdown-format.js";

const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;

export async function drainGatewayActiveWork({
  request,
  runtime,
  drainTimeoutMs,
  restartDrainDeadlineAt,
  markDraining,
  recordCounts,
  recordWarning,
  logger,
}: {
  request: GatewayRunSignalRequest;
  runtime: typeof import("./lifecycle.runtime.js");
  drainTimeoutMs: number | undefined;
  restartDrainDeadlineAt: number | undefined;
  markDraining: (reason: GatewayDrainReason) => void;
  recordCounts: (counts: string) => void;
  recordWarning: (warning: string) => void;
  logger: Pick<SubsystemLogger, "info" | "warn">;
}) {
  const { restartIntent } = request;
  const reportDrainSnapshot = createGatewayDrainReporter(
    request.action,
    drainTimeoutMs,
    runtime,
    logger,
    recordCounts,
  );
  // On restart, wait for the canonical process activity inventory before
  // tearing down the server so active work can settle.
  if (request.action !== "stop") {
    let activeWorkAtDrainStart = 0;
    let activeRunsAtDrainStart = 0;
    let drainTimedOut = false;
    await measureGatewayRestartTrace(
      "restart.drain",
      async () => {
        const { abortEmbeddedAgentRun, createGatewayActiveWorkSnapshot, waitForGatewayActiveWork } =
          runtime;
        // Reject new enqueues immediately during the drain window so
        // sessions get an explicit restart error instead of silent task loss.
        markDraining(formatShutdownReason(request));
        const initialSnapshot = createGatewayActiveWorkSnapshot();
        activeWorkAtDrainStart = initialSnapshot.counts.totalActive;
        activeRunsAtDrainStart = initialSnapshot.counts.embeddedRuns;
        if (activeRunsAtDrainStart > 0) {
          abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
        }

        reportDrainSnapshot(initialSnapshot);
        const remainingDrainTimeoutMs =
          restartDrainDeadlineAt === undefined
            ? undefined
            : Math.max(0, restartDrainDeadlineAt - Date.now());
        const drain = await waitForGatewayActiveWork(remainingDrainTimeoutMs, {
          onSnapshot: reportDrainSnapshot,
        });
        if (drain.drained) {
          if (!initialSnapshot.idle) {
            logger.info("all active work drained");
          }
          return;
        }
        drainTimedOut = true;
        const warning = `restart drain budget ${drainTimeoutMs}ms exhausted; cutting short ${formatDrainCounts(drain.snapshot)}`;
        recordWarning(warning);
        logger.warn(warning);
        // Connection work can retain cron cleanup; cancel before close joins it.
        runtime.abortActiveCronTaskRuns("Gateway restarting.");
      },
      () => [
        ["activeWork", activeWorkAtDrainStart],
        ["activeRuns", activeRunsAtDrainStart],
        ["timedOut", drainTimedOut],
        ["force", restartIntent?.force === true],
      ],
    );
  } else {
    // Keep all process-owned work alive without spending the shutdown reserve
    // that server teardown and the supervisor watchdog need.
    try {
      markGatewayRestartTrace("stop.drain.begin");
      const activeWorkDrain = await measureGatewayRestartTrace("stop.drain", () =>
        runtime.waitForGatewayActiveWork(drainTimeoutMs, {
          onSnapshot: reportDrainSnapshot,
        }),
      );
      if (!activeWorkDrain.drained) {
        logger.warn(
          `gateway active-work drain timeout reached; proceeding with shutdown: ${formatDrainCounts(activeWorkDrain.snapshot)}`,
        );
        runtime.abortEmbeddedAgentRun(undefined, { mode: "all" });
        runtime.abortActiveCronTaskRuns("Gateway stopping.");
      }
    } catch (err) {
      logger.warn(
        `gateway active-work drain failed; proceeding with shutdown: ${formatErrorMessage(err)}`,
      );
    }
    logger.info("active-work drain settled; beginning server close");
  }
}

function createGatewayDrainReporter(
  action: GatewayRunSignalAction,
  drainTimeoutMs: number | undefined,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "getDiagnosticSessionActivitySnapshot"
  >,
  logger: Pick<SubsystemLogger, "info" | "warn">,
  recordCounts: (counts: string) => void,
) {
  const drainBudget =
    drainTimeoutMs === undefined ? "without a timeout" : `with timeout ${drainTimeoutMs}ms`;
  let lastPendingWarningAt: number | undefined;
  return (snapshot: GatewayActiveWorkSnapshot) => {
    recordCounts(formatDrainCounts(snapshot) || "no active work");
    const now = Date.now();
    if (lastPendingWarningAt === undefined) {
      lastPendingWarningAt = now;
      if (!snapshot.idle) {
        logger.info(
          `draining active work before ${action} ${drainBudget}: ${formatDrainCounts(snapshot)}`,
        );
        const requestTimeoutMs = Math.max(
          0,
          ...runtime
            .listActiveEmbeddedRunSessionIds()
            .map(
              (sessionId) =>
                runtime.getDiagnosticSessionActivitySnapshot({ sessionId })
                  ?.activeModelCallRequestTimeoutMs ?? 0,
            ),
        );
        if (requestTimeoutMs > 0) {
          logger.info(
            `largest observed model request timeout is ${requestTimeoutMs}ms; shutdown drain budget remains ${drainBudget}`,
          );
        }
      }
    } else if (
      !snapshot.idle &&
      now - lastPendingWarningAt >= RESTART_DRAIN_STILL_PENDING_WARN_MS
    ) {
      lastPendingWarningAt = now;
      logger.warn(`still draining active work before ${action}: ${formatDrainCounts(snapshot)}`);
    }
  };
}
