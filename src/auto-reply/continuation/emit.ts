import { processCompletion } from "./registry.js";
import type {
  TurnCompletionEvent,
  RunCompletionEvent,
  QueueCompletionEvent,
  ContinuationDecision,
} from "./types.js";

/**
 * Emit turn completion (from handleAgentEnd).
 * Fire-and-forget - does not block the caller.
 */
export function emitTurnCompletion(event: Omit<TurnCompletionEvent, "level" | "timestamp">): void {
  void processCompletion({
    level: "turn",
    timestamp: Date.now(),
    ...event,
  });
}

/**
 * Emit run completion (from finalizeWithFollowup).
 * Returns decision so caller can enqueue continuation if needed.
 */
export async function emitRunCompletion(
  event: Omit<RunCompletionEvent, "level" | "timestamp">,
): Promise<ContinuationDecision> {
  return processCompletion({
    level: "run",
    timestamp: Date.now(),
    ...event,
  });
}

/**
 * Emit queue completion (from scheduleFollowupDrain finally block).
 * Returns decision so caller can re-enqueue if continuation needed.
 */
export async function emitQueueCompletion(
  event: Omit<QueueCompletionEvent, "level" | "timestamp">,
): Promise<ContinuationDecision> {
  return processCompletion({
    level: "queue",
    timestamp: Date.now(),
    ...event,
  });
}
