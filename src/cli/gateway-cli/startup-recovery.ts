import { isInvalidConfigError } from "../../config/io.invalid-config.js";
import { isGatewayEffectiveConfigConflictError } from "../../gateway/server-runtime-config.js";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import type { GatewayCrashLoopBreakerDecision } from "../../infra/gateway-boot-lifecycle.js";
import {
  isTailscaleBackendAuthenticationRequiredError,
  isTailscaleServeAuthenticationRequiredError,
  waitForTailscaleBackendRunning,
} from "../../infra/tailscale-backend-ready.js";
import { isTailscaleRouteOwnershipConflictError } from "../../infra/tailscale-route-ownership-error.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  isGatewayLockError,
  resolveGatewayStartupMaintenanceReason,
} from "./startup-maintenance.js";
import { triageGatewayStartupFailure } from "./startup-triage.js";

/** Own startup recovery admission and the one-triage limit for this CLI invocation. */
export function createGatewayStartupRecovery({
  getBootState,
  isSupervised,
  canRecoverTailscale,
  logger,
  runtime,
}: {
  getBootState: () => { recorded: boolean; decision: GatewayCrashLoopBreakerDecision | undefined };
  isSupervised: () => boolean;
  canRecoverTailscale: () => boolean;
  logger: Pick<SubsystemLogger, "warn" | "info">;
  runtime: RuntimeEnv;
}) {
  let triageAttempted = false;
  const triageStartupFailure = async (error: unknown, signal?: AbortSignal) => {
    if (
      isTailscaleBackendAuthenticationRequiredError(error) ||
      triageAttempted ||
      !getBootState().recorded ||
      signal?.aborted ||
      isAbortError(error) ||
      isGatewayLockError(error) ||
      isInvalidConfigError(error) ||
      isTailscaleRouteOwnershipConflictError(error) ||
      isGatewayEffectiveConfigConflictError(error) ||
      collectNestedErrorCandidates(error).some(
        (candidate) => candidate instanceof GatewayStartupCleanupError,
      ) ||
      resolveGatewayStartupMaintenanceReason(error)
    ) {
      return;
    }
    // Unconfirmed startup cleanup retains its generation; never overlap it with a fixer.
    // Supervised retries reuse the persisted breaker transition to avoid agent storms.
    if (isSupervised() && !getBootState().decision?.shouldWriteStabilityBundle) {
      return;
    }
    triageAttempted = true;
    return await triageGatewayStartupFailure(runtime, error, signal);
  };
  const recoverStartupFailure = async (
    error: unknown,
    signal: AbortSignal,
  ): Promise<"completed" | "failed" | void> => {
    if (isTailscaleServeAuthenticationRequiredError(error)) {
      if (!canRecoverTailscale() || signal.aborted) {
        return;
      }
      logger.warn(
        "Tailscale Serve needs operator sign-in or device approval; Gateway startup is parked until the local backend recovers",
      );
      const running = await waitForTailscaleBackendRunning({
        bin: error.statusCommand.bin,
        prefix: [...error.statusCommand.prefix],
        signal,
        info: (message) => logger.info(message),
      });
      return running ? "completed" : undefined;
    }
    return await triageStartupFailure(error, signal);
  };
  return { triageStartupFailure, recoverStartupFailure };
}
