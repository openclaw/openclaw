/**
 * Tracks active Telegram message dispatches by sequential key.
 *
 * When a message starts full processing (buildContext → dispatch → agent run),
 * its sequential key is registered here. The `sequentialize` middleware checks
 * this to allow concurrent processing of follow-up messages when steer mode is
 * active — bypassing per-chat serialization so the steer check in
 * `get-reply-run.ts` can see the first run as active and inject the second
 * message via `agent.steer()`.
 */

const activeDispatches = new Set<string>();

export function markTelegramDispatchActive(key: string): void {
  activeDispatches.add(key);
}

export function clearTelegramDispatchActive(key: string): void {
  activeDispatches.delete(key);
}

export function isTelegramDispatchActive(key: string): boolean {
  return activeDispatches.has(key);
}
