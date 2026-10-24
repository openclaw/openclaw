import type { SessionControllerWatchdog } from "../../sessions/session-controller.watchdog.js";

export type ReplyOperationStaleReason =
  | "terminal_unreleased"
  | "finalization_stalled"
  | "no_activity"
  | "stuck_recovery";

/** Delivery retains work on the operation's sole watchdog, never a parallel lease. */
export function beginReplyOperationFinalizationWork(
  owner: { readonly watchdog: SessionControllerWatchdog },
  timeoutMs: number,
): () => void {
  return owner.watchdog.beginFinalizationWork(timeoutMs);
}
