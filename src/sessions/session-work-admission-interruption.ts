import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";

/** Only the live run owner can confirm that this interruption accepted a stop. */
type SessionWorkAdmissionInterruptionReceipt = { runId: string };
export type SessionWorkAdmissionInterrupt = (
  reason?: Error,
) => SessionWorkAdmissionInterruptionReceipt | void;

/**
 * Restart classification is opt-in, never the default. `beginSessionWorkAdmission`
 * fills a missing interrupt reason with an untyped Error, and every ordinary
 * interrupter (a queued message taking `run-now`, a session reset, a reply
 * rollover drain, a worker placement move, a compaction checkpoint restore)
 * leaves it that way. Aborting those for restart writes the durable
 * `status: "running"` + `abortedLastRun: true` pair that main-session restart
 * recovery admits on, so the next turn dispatches a recovery that never had a
 * restart behind it. `instanceof` rather than `isGatewayRestartDrainError`: a
 * deferred interrupt can land after the process-global drain flag has reset.
 */
export function isSessionWorkRestartInterruptReason(reason: unknown): boolean {
  return isAgentRunRestartAbortReason(reason) || reason instanceof GatewayDrainingError;
}

/**
 * The abort reason a run-level controller should receive for an admission
 * interrupt. Keeps the restart-abort construction inside this owner so callers
 * that only forward a reason never have to know what a restart abort looks like.
 * Callers that also derive a `stopReason` use the predicate directly instead.
 */
export function resolveInterruptAbortReason(reason: Error | undefined): Error | undefined {
  return isSessionWorkRestartInterruptReason(reason) ? createAgentRunRestartAbortError() : reason;
}

export async function waitForSessionWorkAdmissionRelease(
  released: Promise<void>,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs === undefined) {
    await released;
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      released.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
