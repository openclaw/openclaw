import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

/**
 * Per-session run generation counter. Increments every time the active run
 * is invalidated (user abort, new-message takeover, external cancel).
 *
 * Downstream callers capture the generation at run start and check
 * `isCurrentGeneration` before producing side effects (tool calls, deltas,
 * typing, final delivery). A stale generation means the caller's run has
 * been superseded and its output must be fenced off.
 *
 * This complements `replyRunRegistry` (which owns AbortController semantics)
 * by providing a monotonic stamp that callers can pass through deep call
 * stacks without needing to carry the AbortSignal itself.
 */

type RunGenerationState = {
  generationBySessionKey: Map<string, number>;
};

const RUN_GENERATION_STATE_KEY = Symbol.for("openclaw.runGenerationRegistry");

const runGenerationState = resolveGlobalSingleton<RunGenerationState>(
  RUN_GENERATION_STATE_KEY,
  () => ({
    generationBySessionKey: new Map<string, number>(),
  }),
);

function normalizeKey(sessionKey: string | undefined): string | undefined {
  return normalizeOptionalString(sessionKey);
}

/**
 * Return the current generation for this session, starting at 0 if unseen.
 * Use at run start to capture the generation a caller will validate against.
 */
export function getCurrentGeneration(sessionKey: string): number {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return 0;
  }
  return runGenerationState.generationBySessionKey.get(key) ?? 0;
}

/**
 * Increment the generation for this session and return the new value.
 * Callers should invoke this when they observe an event that invalidates
 * the active run: user abort, new inbound user message, restart, etc.
 */
export function incrementGeneration(sessionKey: string): number {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return 0;
  }
  const next = (runGenerationState.generationBySessionKey.get(key) ?? 0) + 1;
  runGenerationState.generationBySessionKey.set(key, next);
  return next;
}

/**
 * Check whether the captured generation is still the session's current one.
 * A `false` result means the caller's run has been invalidated and any
 * side effect it is about to produce must be suppressed.
 */
export function isCurrentGeneration(sessionKey: string, generation: number): boolean {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return false;
  }
  if (!Number.isFinite(generation)) {
    return false;
  }
  // Treat an unseen session as generation 0 to match `getCurrentGeneration`.
  // Otherwise `isCurrent(0)` would spuriously fail for brand-new sessions.
  return (runGenerationState.generationBySessionKey.get(key) ?? 0) === generation;
}

/**
 * Drop the recorded generation for a session. Used when a session ends
 * cleanly and we want to avoid unbounded map growth.
 *
 * Callers that only want to invalidate (not forget) should use
 * `incrementGeneration` instead.
 */
export function forgetGeneration(sessionKey: string): void {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return;
  }
  runGenerationState.generationBySessionKey.delete(key);
}

export const __testing = {
  resetRunGenerationRegistry(): void {
    runGenerationState.generationBySessionKey.clear();
  },
  peekTrackedSessionCount(): number {
    return runGenerationState.generationBySessionKey.size;
  },
};
