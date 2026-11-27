import {
  captureGatewayRestartTraceHandoff,
  formatGatewayPendingCloseSteps,
} from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import {
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
  formatGatewayRepeatedSignalHint,
} from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { sleep } from "../../utils/sleep.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";
import type { createGatewayRunCleanup } from "./run-loop-cleanup.js";
import type { GatewayRunSignalRequest, GatewayShutdownFailure } from "./run-loop-request.js";
import { armShutdownHardExitWatchdog } from "./shutdown-hard-exit.js";
import type { GatewayUpdateSuccessor } from "./update-successor.js";

export async function waitForLaunchdRestartHandoff(handoffSpawned?: Promise<boolean>) {
  const delay = sleep(1_500);
  const spawned = handoffSpawned
    ? await Promise.race([handoffSpawned, delay.then(() => true)])
    : false;
  // Preserve the crash-loop throttle window even when spawn settles early.
  await delay;
  return spawned;
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

export function armGatewayShutdownHardExitWatchdog(
  delayMs: number,
  logger: Pick<SubsystemLogger, "warn">,
) {
  return armShutdownHardExitWatchdog({
    delayMs,
    describePending: formatGatewayPendingCloseSteps,
    onError: (error) => {
      logger.warn(
        `hard-exit watchdog failed; retaining main-thread shutdown timer: ${formatErrorMessage(error)}`,
      );
    },
  });
}

export function createSupervisorHandoffWriter(params: {
  runtime: Pick<typeof import("./lifecycle.runtime.js"), "writeGatewayRestartHandoff">;
  processInstanceId: string;
  supervisorMode:
    | Parameters<
        typeof import("../../infra/restart-handoff.js").writeGatewayRestartHandoff
      >[0]["supervisorMode"]
    | null;
  isCurrent: (request: GatewayRunSignalRequest | null) => boolean;
}) {
  return (request: GatewayRunSignalRequest | null, kind: "update-process" | "full-process") =>
    params.runtime.writeGatewayRestartHandoff(
      {
        restartKind: kind,
        reason: request?.restartReason,
        processInstanceId: params.processInstanceId,
        supervisorMode: params.supervisorMode ?? "external",
        restartTrace: captureGatewayRestartTraceHandoff(),
      },
      () => {
        if (!params.isCurrent(request)) {
          throw new Error("Gateway restart handoff no longer owns the shutdown request");
        }
      },
    );
}

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;

export function createForcedExitAfterStabilityBundle(params: {
  isClosed: () => boolean;
  isForced: () => boolean;
  markForced: () => void;
  getOwner: () => ManagedUpdateOwner | undefined;
  successor: GatewayUpdateSuccessor;
  retireHost: () => ReturnType<ReturnType<typeof createGatewayHostLifecycle>["retire"]> | undefined;
  cleanup: Pick<ReturnType<typeof createGatewayRunCleanup>, "retain" | "flushLogs">;
  writeStabilityBundle: ReturnType<typeof createGatewayStabilityReporter>;
  forceRestartExit: () => void;
  completeBoot: (completion: GatewayBootLifecycleCompletion) => void;
  finishLoop: (code: number) => void;
  finishRestoring: (code: number, owner: ManagedUpdateOwner | undefined) => Promise<void>;
  graceMs: number;
}) {
  return async (reason: string, exitCode = 1, failure?: GatewayShutdownFailure) => {
    if (
      params.isClosed() ||
      (params.successor.waitingForStop && !params.getOwner()) ||
      params.isForced()
    ) {
      return;
    }
    params.markForced();
    const retirement = params.retireHost();
    if (retirement) {
      params.cleanup.retain(retirement);
    }
    let stabilityFailure: { error: unknown } | undefined;
    try {
      params.writeStabilityBundle(reason, failure?.error, failure?.step);
    } catch (error) {
      stabilityFailure = { error };
    }
    // Exit rescue cannot replay an issued file append; join it before final authority checks.
    // Reserve half the hard-exit grace for final shutdown bookkeeping.
    await params.cleanup.flushLogs(params.graceMs / 2);
    if (params.isClosed()) {
      return;
    }
    const owner = params.getOwner();
    if (owner) {
      params.forceRestartExit();
    }
    const restoration = await params.successor.cancelHandoff(params.getOwner, owner);
    if (restoration) {
      params.completeBoot({ outcome: "forced_stop", reason });
      if (restoration === "restart-after-exit") {
        await params.finishRestoring(exitCode, owner);
      } else {
        params.finishLoop(exitCode);
      }
    } else if (params.successor.capturedStop) {
      await params.successor.exit(exitCode, (code) => {
        params.completeBoot({ outcome: "forced_stop", reason });
        params.finishLoop(code);
      });
    }
    if (stabilityFailure) {
      throw stabilityFailure.error;
    }
  };
}

export async function releaseRetiringGatewayCustody(
  cleanup: Pick<ReturnType<typeof createGatewayRunCleanup>, "waitForPersistence">,
  bootCompletion: Promise<void> | undefined,
  lock: { release: () => Promise<void> } | null,
  supervisorMode: string | null,
): Promise<void> {
  const persisted = await cleanup.waitForPersistence(bootCompletion);
  if (supervisorMode === "schtasks") {
    if (!persisted) {
      throw new Error("Gateway state custody release did not settle; successor cannot start");
    }
    // Native borrowers must join; the accepted stop's watchdog owns this deadline.
    await lock?.release();
  } else {
    await cleanup.waitForPersistence(lock?.release());
  }
}
