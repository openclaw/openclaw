import type {
  CompletionEvent,
  CompletionHandler,
  CompletionHandlerRegistration,
  ContinuationDecision,
} from "./types.js";

const handlers: CompletionHandlerRegistration[] = [];

/**
 * Register a completion handler. Returns unsubscribe function.
 */
export function onCompletion(
  handler: CompletionHandler,
  opts?: Partial<Omit<CompletionHandlerRegistration, "handler">>,
): () => void {
  const registration: CompletionHandlerRegistration = {
    id: opts?.id ?? `handler-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    handler,
    priority: opts?.priority ?? 100,
    levels: opts?.levels,
  };
  handlers.push(registration);
  handlers.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return () => {
    const idx = handlers.indexOf(registration);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/**
 * Process completion event through all handlers.
 * Returns first actionable decision (non-"none" action, or "none" with reason/goalUpdate).
 */
export async function processCompletion(event: CompletionEvent): Promise<ContinuationDecision> {
  if (handlers.length === 0) return { action: "none" };

  for (const { handler, levels, id } of handlers) {
    // Skip if handler doesn't handle this level
    if (levels && !levels.includes(event.level)) continue;

    try {
      const result = await handler(event);
      if (!result) continue;

      // Return if action is non-"none", or if it's "none" with additional info (reason/goalUpdate)
      const hasAdditionalInfo = result.reason || result.goalUpdate;
      if (result.action !== "none" || hasAdditionalInfo) {
        return { ...result, reason: result.reason ?? `decided by ${id}` };
      }
    } catch (err) {
      console.error(`Continuation handler ${id} error:`, err);
    }
  }

  return { action: "none" };
}

/** Clear all handlers (for testing) */
export function clearCompletionHandlers(): void {
  handlers.length = 0;
}

/** Get handler count (for testing/debugging) */
export function getHandlerCount(): number {
  return handlers.length;
}
