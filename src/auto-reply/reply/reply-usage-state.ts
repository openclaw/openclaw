import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";

const TTL_MS = 5 * 60_000;

const store = new Map<string, { snapshot: PluginHookReplyUsageState; expiresAt: number }>();

function prune(now: number): void {
  for (const [key, value] of store) {
    if (value.expiresAt < now) {
      store.delete(key);
    }
  }
}

export function recordReplyUsageState(
  runId: string | undefined,
  snapshot: PluginHookReplyUsageState,
): void {
  if (!runId) {
    return;
  }
  const now = Date.now();
  store.set(runId, { snapshot, expiresAt: now + TTL_MS });
  prune(now);
}

export function consumeReplyUsageState(runId?: string): PluginHookReplyUsageState | undefined {
  if (!runId) {
    return undefined;
  }
  const value = store.get(runId);
  return value && value.expiresAt >= Date.now() ? value.snapshot : undefined;
}

export function clearReplyUsageStateForTest(): void {
  store.clear();
}
