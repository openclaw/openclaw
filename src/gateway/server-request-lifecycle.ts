import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../packages/gateway-protocol/src/restart-unavailable.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";

// These methods observe another owner's result. Login and lifecycle waits also
// mutate state and must retain their existing execution lifetime.
const OBSERVATION_METHODS = new Set([
  "agent.wait",
  "exec.approval.waitDecision",
  "plugin.approval.waitDecision",
  "question.waitAnswer",
  "device.scopes.waitUpgrade",
]);

export function isGatewayObservationMethod(method: string): boolean {
  return OBSERVATION_METHODS.has(method);
}

export function workAdmissionUnavailableError(method: string) {
  const restartDraining = isGatewayRestartDraining();
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `${method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
    {
      retryable: true,
      retryAfterMs:
        !restartDraining && method === "agent.identity.get"
          ? GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS
          : 1_000,
      details: {
        method,
        reason: restartDraining
          ? GATEWAY_RESTART_UNAVAILABLE_REASON
          : GATEWAY_SUSPEND_UNAVAILABLE_REASON,
        phase: getGatewaySuspendAdmissionPhase(),
      },
    },
  );
}

/** Cancels passive waiters without abandoning their owner's admitted writes. */
export async function runWithGatewayObservationScope<T>(
  run: () => T | Promise<T>,
  requestSignals: (AbortSignal | undefined)[],
  cancelled: () => T | Promise<T>,
): Promise<T> {
  const work = new AsyncWorkScope();
  const signal = AbortSignal.any(
    [getGatewayRestartDrainSignal(), getAsyncWorkSignal(), ...requestSignals].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  const close = () => work.beginClose(signal.reason);
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
  }
  try {
    work.signal.throwIfAborted();
    const result = await work.track(run);
    work.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (!work.signal.aborted) {
      throw error;
    }
    return await cancelled();
  } finally {
    signal.removeEventListener("abort", close);
    await work.drain();
  }
}
