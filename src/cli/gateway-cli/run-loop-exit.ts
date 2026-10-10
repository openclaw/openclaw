import { performance } from "node:perf_hooks";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import {
  formatGatewayPendingCloseSteps,
  measureGatewayCloseStep,
} from "../../gateway/restart-trace.js";
import { flushDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
  formatGatewayRepeatedSignalHint,
  type GatewayBootLifecycleCompletion,
} from "../../infra/gateway-boot-lifecycle.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import { flushLogger } from "../../logging/logger.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";
import { formatShutdownCompletion } from "./run-loop-shutdown-format.js";

type ExitLogger = Pick<SubsystemLogger, "info" | "warn">;
type ExitRuntime = Pick<
  typeof import("./lifecycle.runtime.js"),
  "stopActiveManagedProviderLocalServices"
>;

export async function waitForLaunchdRestartHandoff(handoffSpawned?: Promise<boolean>) {
  const delay = sleep(1_500);
  const spawned = handoffSpawned
    ? await Promise.race([handoffSpawned, delay.then(() => true)])
    : false;
  // Preserve the crash-loop throttle window even when spawn settles early.
  await delay;
  return spawned;
}

export async function prepareGatewayExit(
  runtime: ExitRuntime,
  logger: ExitLogger,
  skipLocalServices = false,
  handoff?: { releaseLock: () => Promise<void>; exit: () => void },
): Promise<void> {
  const exitTimer = handoff
    ? setTimeout(() => {
        logger.warn(
          `shutdown exit deadline reached; pending close steps: ${formatGatewayPendingCloseSteps()}`,
        );
        handoff.exit();
      }, 5_000)
    : undefined;
  const step = (name: string, run: () => Promise<void>) =>
    measureGatewayCloseStep(`restart.close.${name}`, run);
  try {
    if (!skipLocalServices) {
      await step("managed-local-services", () =>
        runWithProcessCleanupBudget(
          handoff
            ? { deadline: performance.now() + 3_000, warn: (message) => logger.warn(message) }
            : undefined,
          runtime.stopActiveManagedProviderLocalServices,
        ).catch((error: unknown) => {
          logger.warn(`managed local service shutdown failed: ${formatErrorMessage(error)}`);
        }),
      );
    }
    if (handoff) {
      await step("gateway-lock-release", handoff.releaseLock);
    } else {
      await step("snapshot-operations", cleanupSnapshotOperations);
    }
    await step("log-flush", () => flushGatewayLogsBeforeExit(logger, handoff ? 1_000 : 4_000));
    handoff?.exit();
  } finally {
    clearTimeout(exitTimer);
  }
}

/** Only a timed-out process exit may discard teardown after database close. */
export function interruptedShutdownExitOptions(params: {
  request: GatewayRunSignalRequest;
  drainCutShort: boolean;
  ownsProcessLifecycle?: boolean;
  runtime: ExitRuntime;
  logger: ExitLogger;
  releaseLock: () => Promise<void>;
  completeBoot: (completion: GatewayBootLifecycleCompletion) => void;
  exit: (code: number) => void;
}): { onProcessExitReady?: () => Promise<void> } {
  if (
    params.request.action === "restart" ||
    params.request.hostedStop ||
    !params.drainCutShort ||
    params.ownsProcessLifecycle !== true
  ) {
    return {};
  }
  return {
    onProcessExitReady: async () => {
      // Boot outcome is a write: retain state authority until it commits.
      params.completeBoot(formatShutdownCompletion(params.request, false));
      await prepareGatewayExit(params.runtime, params.logger, false, {
        releaseLock: params.releaseLock,
        exit: () => params.exit(0),
      });
    },
  };
}

export async function flushGatewayLogsBeforeExit(
  logger: { warn: (message: string) => void },
  timeoutMs = 4_000,
) {
  flushDiagnosticsTimeline();
  const flushed = await raceWithTimeout(
    flushLogger().then(() => true),
    timeoutMs,
    () => false,
  );
  if (!flushed) {
    logger.warn(`log flush did not settle within ${timeoutMs}ms; continuing shutdown`);
  }
}

export function createGatewaySignalObserver(logger: Pick<SubsystemLogger, "warn">) {
  const recentSignals = new Map<NodeJS.Signals, number[]>();
  return (signal: NodeJS.Signals) => {
    const now = Date.now();
    const times = (recentSignals.get(signal) ?? []).filter(
      (time) => now - time <= GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
    );
    times.push(now);
    recentSignals.set(signal, times.slice(-3));
    if (times.length === 3) {
      logger.warn(formatGatewayRepeatedSignalHint(signal, 3));
    }
  };
}

export function createGatewayStabilityReporter(
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "writeDiagnosticStabilityBundleForFailureSync"
  >,
  logger: Pick<SubsystemLogger, "warn">,
) {
  return (reason: string, error?: unknown, shutdownStep?: string) => {
    const result = runtime.writeDiagnosticStabilityBundleForFailureSync(
      reason,
      error,
      ...(shutdownStep ? [{ shutdownStep }] : []),
    );
    logger.warn(result.message);
  };
}
