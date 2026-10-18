import { settlesWithin } from "../shared/settle-within.js";

/** Only the live run owner can confirm that this interruption accepted a stop. */
type SessionWorkAdmissionInterruptionReceipt = { runId: string };
export type SessionWorkAdmissionInterrupt = (
  reason?: Error,
) => SessionWorkAdmissionInterruptionReceipt | void;

export function sessionWorkAdmissionAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("session work admission aborted");
}

export async function waitForSessionWorkAdmissionRelease(
  released: Promise<void>,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs === undefined) {
    await released;
    return true;
  }
  return await settlesWithin(released, Math.max(0, timeoutMs));
}
