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

const activeDispatches = new Map<string, number>();

export function markTelegramDispatchActive(key: string): void {
  activeDispatches.set(key, (activeDispatches.get(key) ?? 0) + 1);
}

export function clearTelegramDispatchActive(key: string): void {
  const count = activeDispatches.get(key) ?? 0;
  if (count <= 1) {
    activeDispatches.delete(key);
  } else {
    activeDispatches.set(key, count - 1);
  }
}

export function isTelegramDispatchActive(key: string): boolean {
  return (activeDispatches.get(key) ?? 0) > 0;
}
