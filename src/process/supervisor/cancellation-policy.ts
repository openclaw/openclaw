import type { TerminationReason } from "./types.js";

// Every adapter must preserve the same graceful-cancel window before escalation.
export const GRACEFUL_CANCEL_TIMEOUT_MS = 5_000;

export function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}
