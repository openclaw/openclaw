import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import type { GatewayServer } from "../../gateway/server-public.js";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import type { GatewayInstallationReplacement } from "../../gateway/stale-install.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { TAILSCALE_BACKEND_AUTH_REQUIRED_REASON } from "../../infra/tailscale-backend-auth-required-error.js";
import { isTailscaleServeAuthenticationRequiredError } from "../../infra/tailscale-backend-ready.js";
import type { createGatewayRunCleanup } from "./run-loop-cleanup.js";
import { formatStartupFailureCompletion } from "./run-loop-shutdown-format.js";
import type { createGatewayRunSignals } from "./run-loop-signals.js";
import type {
  createGatewayRestartRecovery,
  createGatewayStartupOperations,
} from "./run-loop-startup.js";

/** Settle the failed generation before recovery can admit another startup. */
export async function settleGatewayStartupFailure({
  error: err,
  failedServer,
  isStartupRecoveryRetry,
  isRestartIteration,
  supervised,
  canRecover,
  cleanup,
  signals,
  startupOperations: iterationStartupOperations,
  recovery,
  completeBoot,
  getInstallationReplacement,
  isTerminal,
  isShuttingDown,
  hasPendingStartupRequest,
  markFailedWithoutServerHandle,
  releaseLockIfHeld,
  exitReplacedInstallation,
  writeStabilityBundle,
}: {
  error: unknown;
  failedServer: GatewayServer | null;
  isStartupRecoveryRetry: boolean;
  isRestartIteration: boolean;
  supervised: boolean;
  canRecover: boolean;
  cleanup: ReturnType<typeof createGatewayRunCleanup>;
  signals: Pick<ReturnType<typeof createGatewayRunSignals>, "settle" | "openStore">;
  startupOperations: ReturnType<typeof createGatewayStartupOperations>;
  recovery: ReturnType<typeof createGatewayRestartRecovery>;
  completeBoot: (completion: GatewayBootLifecycleCompletion) => void;
  getInstallationReplacement: () => GatewayInstallationReplacement | undefined;
  isTerminal: () => boolean;
  isShuttingDown: () => boolean;
  hasPendingStartupRequest: () => boolean;
  markFailedWithoutServerHandle: () => void;
  releaseLockIfHeld: () => Promise<void>;
  exitReplacedInstallation: (replacement: GatewayInstallationReplacement) => Promise<void>;
  writeStabilityBundle: (reason: string, error: unknown) => void;
}): Promise<"stop" | "retry" | "wait"> {
  const maintenanceRequired = findStartupMaintenanceRequiredError(err);
  const canWaitForTailscaleServe =
    !maintenanceRequired &&
    !getInstallationReplacement() &&
    !isStartupRecoveryRetry &&
    !isShuttingDown() &&
    !isTerminal() &&
    supervised &&
    canRecover &&
    isTailscaleServeAuthenticationRequiredError(err);
  let bootFailureCompleted = false;
  const completeStartupFailure = (startupReason?: string, failure?: { error: unknown }) => {
    if (bootFailureCompleted) {
      return;
    }
    const startupFailure = failure ? failure.error : err;
    completeBoot(formatStartupFailureCompletion(startupFailure, startupReason));
    bootFailureCompleted = true;
  };
  if (!canWaitForTailscaleServe) {
    completeStartupFailure(maintenanceRequired?.code);
  }
  try {
    await signals.settle();
    await failedServer?.close({ reason: "gateway startup failed", retainSharedState: true });
  } catch (closeError) {
    completeStartupFailure(maintenanceRequired?.code);
    throw new GatewayStartupCleanupError(err, closeError);
  } finally {
    signals.openStore();
  }
  // The startup owner uses this error only when native retirement is unconfirmed.
  // Keep its dependencies retained, including when the installation was replaced.
  if (
    collectNestedErrorCandidates(err).some((error) => error instanceof GatewayStartupCleanupError)
  ) {
    completeStartupFailure(maintenanceRequired?.code);
    throw err;
  }
  const replacement = getInstallationReplacement();
  if (replacement) {
    completeStartupFailure(maintenanceRequired?.code);
    await exitReplacedInstallation(replacement);
    return "stop";
  }
  // Keep TCC recovery after clean restart failures (#35862), but never reuse a
  // generation whose startup cleanup failed. The outer CLI exits nonzero.
  if (
    isTerminal() ||
    maintenanceRequired ||
    (!isRestartIteration && !canWaitForTailscaleServe) ||
    (isStartupRecoveryRetry && supervised) ||
    err instanceof GatewayStartupCleanupError
  ) {
    await cleanup.waitForCleanup();
    if (!cleanup.failed && !cleanup.drained) {
      try {
        try {
          await iterationStartupOperations.drain();
        } catch (startupError) {
          // The admission scope remembers the original refusal as well as joining work.
          if (startupError !== err) {
            throw startupError;
          }
        }
        // A clean kernel rollback does not own process-wide providers or snapshots.
        await cleanup.drainProcessResources();
      } catch (cleanupError) {
        throw new GatewayStartupCleanupError(err, cleanupError);
      }
    }
    throw err;
  }
  markFailedWithoutServerHandle();
  if (!hasPendingStartupRequest()) {
    // A failed listener must release its lock for daemon restart/stop (#35862).
    if (!canWaitForTailscaleServe) {
      await releaseLockIfHeld();
    }
  }
  if (canWaitForTailscaleServe) {
    let additionalStartupFailure: unknown;
    let hasAdditionalStartupFailure = false;
    try {
      await cleanup.waitForCleanup();
      if (cleanup.failed) {
        throw new Error("gateway cleanup failed before Tailscale Serve recovery wait", {
          cause: err,
        });
      }
      try {
        await iterationStartupOperations.drain();
      } catch (startupError) {
        if (startupError !== err) {
          additionalStartupFailure = startupError;
          hasAdditionalStartupFailure = true;
        }
      }
      await cleanup.drainProcessResources();
      await cleanup.waitForCleanup();
      if (cleanup.failed) {
        throw new Error("gateway process cleanup failed before Tailscale Serve recovery wait", {
          cause: err,
        });
      }
    } catch (cleanupError) {
      completeStartupFailure();
      throw new GatewayStartupCleanupError(err, cleanupError);
    }
    if (hasAdditionalStartupFailure) {
      completeStartupFailure(undefined, { error: additionalStartupFailure });
      throw additionalStartupFailure;
    }
    iterationStartupOperations.acknowledgeHandledFailure(err);
    try {
      await iterationStartupOperations.drain();
    } catch (startupError) {
      completeStartupFailure(undefined, { error: startupError });
      throw startupError;
    }
    const recoveredReplacement = getInstallationReplacement();
    if (recoveredReplacement) {
      completeStartupFailure();
      await exitReplacedInstallation(recoveredReplacement);
      return "stop";
    }
    const stopCompletion = iterationStartupOperations.getStopCompletion();
    if (stopCompletion) {
      completeStartupFailure();
      await stopCompletion;
      return "stop";
    }
    if (isTerminal() || isShuttingDown()) {
      completeStartupFailure();
      throw err;
    }
  }
  writeStabilityBundle("gateway.restart_startup_failed", err);
  let retryAfterStartupRecovery = false;
  recovery.reportStartupFailure(err, isStartupRecoveryRetry);
  if (!isShuttingDown() && !isStartupRecoveryRetry) {
    try {
      retryAfterStartupRecovery = (await recovery.attempt(err)) && !isShuttingDown();
    } catch (recoveryError) {
      completeStartupFailure(undefined, { error: recoveryError });
      throw recoveryError;
    }
  }
  completeStartupFailure(TAILSCALE_BACKEND_AUTH_REQUIRED_REASON);
  if (!retryAfterStartupRecovery && !isShuttingDown()) {
    recovery.reportManualRecovery();
  }
  return retryAfterStartupRecovery ? "retry" : "wait";
}
