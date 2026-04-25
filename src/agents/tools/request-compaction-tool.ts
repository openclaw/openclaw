import { Type } from "typebox";
import { createExpiringMapCache } from "../../config/cache-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("continuation/request-compaction");

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Minimum context usage (0-1) before the tool will accept a compaction request. */
const MIN_CONTEXT_THRESHOLD = 0.7;

/** Minimum milliseconds between compaction requests per session. */
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

/** Volitional compaction counts are status-only diagnostics, not durable state. */
const VOLITIONAL_COMPACTION_COUNT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Per-session state for guards.
 *
 * Module-level map — same volatility contract as continuation-delegate-store.
 * Does not survive gateway restarts. This is intentional: the guards are
 * rate-limiters, not durable state. A restart resets the cooldown, which is
 * fine — the session itself is fresh.
 */
const sessionGuardState = createExpiringMapCache<
  string,
  {
    lastRequestMs: number;
  }
>({
  ttlMs: RATE_LIMIT_MS,
});

/**
 * Tracks sessions that have a compaction request in-flight.
 * Used to dedup — if the agent calls request_compaction twice before the
 * first one completes, the second call returns "already pending".
 */
const pendingCompactionSessions = new Set<string>();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RequestCompactionToolSchema = Type.Object({
  reason: Type.String({
    description:
      "Why the agent is requesting compaction now. Logged for diagnostics. " +
      "Example: 'context pressure at 92%, working state evacuated to memory files and 2 post-compaction delegates staged.'",
    maxLength: 1024,
  }),
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RequestCompactionToolOpts = {
  /** Current session key (e.g. "telegram:12345"). */
  agentSessionKey?: string;
  /** Session id (the Pi session UUID). */
  sessionId?: string;
  /**
   * Returns the current context usage as a fraction (0-1).
   * Injected so the tool does not reach into session internals.
   */
  getContextUsage: () => number;
  /**
   * Async function that triggers compaction. Injected so the tool does not
   * import the heavy compaction module directly. The caller provides a
   * closure over `compactEmbeddedPiSession` with all required session params.
   */
  triggerCompaction: () => Promise<{ ok: boolean; compacted: boolean; reason?: string }>;
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the `request_compaction` tool.
 *
 * This tool allows the agent to **request** compaction after it has prepared —
 * evacuated working state to memory files, staged post-compaction delegates,
 * or otherwise accepted the context loss.
 *
 * The tool is ASYNC: it enqueues compaction and returns immediately. The
 * compaction runs between turns via the lane queue, not during the tool call.
 *
 * Guards (all checked before compaction is enqueued):
 *   - **Dedup:** a compaction request is not already pending for this session.
 *   - **Context threshold:** context usage must be >= 70%.
 *   - **Rate limit:** at most one compaction per 5 minutes per session.
 *
 * (The earlier "generation guard" was removed 2026-04-15 by RFC: compaction
 * is no longer blocked by mid-turn message arrival because the lane queue
 * already serializes compaction relative to subsequent messages.)
 */
export function createRequestCompactionTool(opts: RequestCompactionToolOpts): AnyAgentTool {
  return {
    label: "Compaction",
    name: "request_compaction",
    description:
      "Request compaction of the current session to reclaim context window space. " +
      "Call this AFTER you have evacuated working state (memory files, post-compaction delegates, RESUMPTION.md). " +
      "Guards: context must be >= 70% full, and rate-limited to once per 5 minutes per session. " +
      "Compaction is async — it runs after your turn completes. " +
      "Prefer this over waiting for automatic compaction when you have context-pressure awareness and want " +
      "to control the timing of state evacuation.",
    parameters: RequestCompactionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "request_compaction requires an active session. Not available in sessionless contexts.",
        );
      }

      if (!opts.sessionId) {
        throw new ToolInputError(
          "request_compaction requires a sessionId. Session may not be fully initialized.",
        );
      }

      const reason = readStringParam(params, "reason", { required: true }).slice(0, 1024);

      // ----- Guard 0: Dedup — compaction already pending -----
      if (pendingCompactionSessions.has(sessionKey)) {
        log.debug(`[request_compaction:already-pending] session=${sessionKey}`);
        return jsonResult({
          status: "already_pending",
          reason: "A compaction request is already in-flight for this session.",
        });
      }

      // ----- Guard 1: Context threshold -----
      const contextUsage = opts.getContextUsage();
      if (contextUsage < MIN_CONTEXT_THRESHOLD) {
        log.debug(
          `[request_compaction:below-threshold] session=${sessionKey} usage=${(contextUsage * 100).toFixed(1)}%`,
        );
        return jsonResult({
          status: "rejected",
          guard: "context_threshold",
          contextUsage: Math.round(contextUsage * 100),
          threshold: Math.round(MIN_CONTEXT_THRESHOLD * 100),
          reason: `Context usage (${Math.round(contextUsage * 100)}%) is below the minimum threshold (${Math.round(MIN_CONTEXT_THRESHOLD * 100)}%). Compaction is not needed yet.`,
        });
      }

      // ----- Guard 2: Rate limit -----
      const now = Date.now();
      const guard = sessionGuardState.get(sessionKey);
      if (guard && now - guard.lastRequestMs < RATE_LIMIT_MS) {
        const remainingMs = RATE_LIMIT_MS - (now - guard.lastRequestMs);
        const remainingSec = Math.ceil(remainingMs / 1000);
        log.debug(
          `[request_compaction:rate-limited] session=${sessionKey} remainingSec=${remainingSec}`,
        );
        return jsonResult({
          status: "rejected",
          guard: "rate_limit",
          retryAfterSeconds: remainingSec,
          reason: `Rate limited. Next compaction request allowed in ${remainingSec}s.`,
        });
      }

      // ----- All guards passed — enqueue compaction -----
      // No generation guard (removed 2026-04-15 RFC): compaction is not blocked
      // by unrelated channel activity.
      log.info(
        `[request_compaction:enqueuing] session=${sessionKey} usage=${(contextUsage * 100).toFixed(1)}% reason=${reason}`,
      );

      // Update rate-limit state BEFORE firing so a second call in the same
      // turn (or a crash during compaction) still respects the cooldown.
      sessionGuardState.set(sessionKey, {
        lastRequestMs: now,
      });

      // Fire-and-forget: compaction runs via the lane queue after the current
      // agent turn releases the session lane. We do NOT await — the tool
      // returns immediately so the agent can finish its response.
      pendingCompactionSessions.add(sessionKey);
      void opts
        .triggerCompaction()
        .then(
          (result) => {
            if (result.ok && result.compacted) {
              incrementVolitionalCompactionCount(sessionKey);
            }
          },
          (err: unknown) => {
            log.error(
              `[request_compaction:background-error] session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
            );
          },
        )
        .finally(() => {
          pendingCompactionSessions.delete(sessionKey);
        });

      return jsonResult({
        status: "compaction_requested",
        contextUsage: Math.round(contextUsage * 100),
        reason,
        note:
          "Compaction has been enqueued and will run after your turn completes. " +
          "Post-compaction context (AGENTS.md, SOUL.md) will be injected on the next turn. " +
          "Any staged post-compaction delegates will be dispatched.",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Volitional compaction counter (module-level, survives compaction)
// ---------------------------------------------------------------------------

const volitionalCompactionCounts = createExpiringMapCache<string, number>({
  ttlMs: VOLITIONAL_COMPACTION_COUNT_TTL_MS,
});

/** Increment the volitional compaction counter for a session. */
export function incrementVolitionalCompactionCount(sessionKey: string): void {
  volitionalCompactionCounts.set(sessionKey, (volitionalCompactionCounts.get(sessionKey) ?? 0) + 1);
}

/** Get the volitional compaction count for a session. */
export function getVolitionalCompactionCount(sessionKey: string): number {
  return volitionalCompactionCounts.get(sessionKey) ?? 0;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset per-session guard state. Exported for tests only. */
export function _resetGuardState(sessionKey?: string): void {
  if (sessionKey) {
    sessionGuardState.delete(sessionKey);
    pendingCompactionSessions.delete(sessionKey);
  } else {
    sessionGuardState.clear();
    pendingCompactionSessions.clear();
  }
}

/** Mark a session as having a pending compaction. Exported for tests only. */
export function _setPending(sessionKey: string): void {
  pendingCompactionSessions.add(sessionKey);
}

/** Reset volitional compaction counters. Exported for tests only. */
export function _resetVolitionalCounts(sessionKey?: string): void {
  if (sessionKey) {
    volitionalCompactionCounts.delete(sessionKey);
  } else {
    volitionalCompactionCounts.clear();
  }
}

/** Expose constants for test assertions. */
export const _guards = {
  MIN_CONTEXT_THRESHOLD,
  RATE_LIMIT_MS,
  VOLITIONAL_COMPACTION_COUNT_TTL_MS,
} as const;
