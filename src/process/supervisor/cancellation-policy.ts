import type { TerminationReason } from "./types.js";

// Every adapter must preserve the same graceful-cancel window before escalation.
export const GRACEFUL_CANCEL_TIMEOUT_MS = 5_000;

// Agent commands complete this long after root exit even if a descendant keeps the output open.
export const ROOT_EXIT_OUTPUT_GRACE_MS = 250;

export function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}
