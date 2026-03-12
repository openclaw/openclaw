/**
 * Tracks active Telegram message dispatches by sequential key.
 *
 * When a message starts full processing (buildContext → dispatch → agent run),
 * its sequential key is registered here. The `sequentialize` middleware checks
 * this to allow concurrent processing of follow-up messages when steer mode is
 * active — bypassing per-chat serialization so the steer check in
 * `get-reply-run.ts` can see the first run as active and inject the second
 * message via `agent.steer()`.
 *
 * Uses reference counting so concurrent dispatches for the same key (the
 * primary run + steered follow-ups) keep the key marked active until ALL
 * dispatches complete.
 */

import { createActiveDispatchTracker } from "../channels/active-dispatches.js";

const tracker = createActiveDispatchTracker();

export function markTelegramDispatchActive(key: string): void {
  tracker.mark(key);
}

export function clearTelegramDispatchActive(key: string): void {
  tracker.clear(key);
}

export function isTelegramDispatchActive(key: string): boolean {
  return tracker.isActive(key);
}
