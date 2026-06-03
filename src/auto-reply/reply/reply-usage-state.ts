import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";

/**
 * Per-run execution-state handoff for the `reply_payload_sending` hook.
 *
 * The reply `beforeDeliver` hook is installed *before* the agent runs but fires
 * *after* it, so post-run state (model / usage / context) cannot be threaded
 * through the pre-run reply options. The agent runner records a snapshot here
 * once `runResult.meta` is available; the dispatch path consumes it at fire time
 * by `runId` and/or `sessionKey`. This is harness-agnostic — every harness
 * (embedded, CLI, Codex app-server) produces the unified `runResult.meta`,
 * unlike the per-call `llm_output` hook which only the embedded/CLI runners emit.
 */
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
  keys: { runId?: string; sessionKey?: string },
  snapshot: PluginHookReplyUsageState,
): void {
  const now = Date.now();
  const entry = { snapshot, expiresAt: now + TTL_MS };
  if (keys.runId) {
    store.set(`run:${keys.runId}`, entry);
  }
  if (keys.sessionKey) {
    store.set(`sk:${keys.sessionKey}`, entry);
  }
  prune(now);
}

export function consumeReplyUsageState(
  runId?: string,
  sessionKey?: string,
): PluginHookReplyUsageState | undefined {
  const now = Date.now();
  for (const key of [
    runId ? `run:${runId}` : undefined,
    sessionKey ? `sk:${sessionKey}` : undefined,
  ]) {
    if (!key) {
      continue;
    }
    const value = store.get(key);
    if (value && value.expiresAt >= now) {
      return value.snapshot;
    }
  }
  return undefined;
}

export function clearReplyUsageStateForTest(): void {
  store.clear();
}
