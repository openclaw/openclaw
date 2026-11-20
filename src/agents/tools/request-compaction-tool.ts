import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { withContinuationOwner } from "../../auto-reply/continuation/system-event-ownership.js";
import { createExpiringMapCache } from "../../config/cache-utils.js";
import { formatCurrentSpanContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createCompactionDiagId,
  type RequestCompactionInvocation,
} from "../compaction-attribution.js";
import {
  classifyCompactionReason,
  isCompactionSkipCode,
} from "../embedded-agent-runner/compact-reasons.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam, ToolInputError } from "./common.js";

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

/** Why a live runner has no measured context usage to compare with the threshold. */
export type RequestCompactionUnmeasuredCause = "no_fresh_usage" | "unknown_context_window";

const UNMEASURED_REASONS: Record<RequestCompactionUnmeasuredCause | "inventory_only", string> = {
  no_fresh_usage: `Context usage has not been measured: this session has no fresh token totals from a completed model turn (as on its first turn, or when the provider reported no usage). request_compaction can check the ${Math.round(MIN_CONTEXT_THRESHOLD * 100)}% threshold only after a completed turn records them.`,
  unknown_context_window: `Context usage cannot be measured: the context window of this session's model is unknown, so usage cannot be compared with the ${Math.round(MIN_CONTEXT_THRESHOLD * 100)}% threshold.`,
  inventory_only:
    "Context usage is unknown for this session; request_compaction is unavailable on inventory-only paths.",
};

/**
 * Per-session state for guards.
 *
 * Module-level map — unlike the durable custody-backed delegate store.
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
      "Example: 'context pressure at 72%, working state evacuated to memory files and 2 post-compaction delegates staged.'",
    maxLength: 1024,
  }),
  focus: Type.Optional(
    Type.String({
      description:
        "Optional instructions that steer what the compaction summary should preserve. " +
        "Use this to name load-bearing facts, decisions, files, or open questions the summarizer must keep.",
      maxLength: 4096,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The closures a live runner (or an inventory stub) supplies to request_compaction. */
export type RequestCompactionRunOpts = {
  /** Session id (the Pi session UUID). */
  sessionId?: string;
  /**
   * Exact admitted originating agent for async failure events.
   * Live spawn-init/follow-up constructors stamp the invoking runner agent.
   * Inventory stubs omit this so unowned shared-session events cannot leak.
   */
  ownerAgentId?: string;
  /**
   * Returns the current context usage as a fraction (0-1). A live runner that
   * cannot measure it returns the cause instead; the inventory-only stub used
   * by catalog/dispatch builds returns null.
   * Injected so the tool does not reach into session internals.
   */
  getContextUsage: () => number | RequestCompactionUnmeasuredCause | null;
  /**
   * Who supplies getContextUsage. Decides how a bare null is reported: from a
   * live runner, usage is not measured yet; from any other origin, this is an
   * inventory-only path.
   */
  contextUsageOrigin?: "live_runner" | "inventory_stub";
  /**
   * Async function that triggers compaction. Injected so the tool does not
   * import the heavy compaction module directly. The caller provides a
   * closure over `compactEmbeddedAgentSession` with all required session params.
   */
  triggerCompaction: (request: RequestCompactionInvocation) => Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    /** The committed summary failed its quality audit and was kept as degraded. */
    qualityDegraded?: boolean;
  }>;
};

export type RequestCompactionToolOpts = RequestCompactionRunOpts & {
  /** Current session key (e.g. "telegram:12345"). */
  agentSessionKey?: string;
  /** Stable run identifier for this agent invocation. */
  runId?: string;
  enqueueSystemEvent?: typeof enqueueSystemEvent;
};

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notifyCompactionFailure(params: {
  enqueue: typeof enqueueSystemEvent;
  sessionKey: string;
  ownerAgentId?: string;
  runId?: string;
  sessionId?: string;
  diagId: string;
  code: string;
  reason: string;
}): void {
  try {
    params.enqueue(
      `[system:compaction-failed] Volitional compaction request ${params.diagId} failed (code=${params.code}, reason=${params.reason}). Your evacuated state was NOT compacted. Staged post-compaction delegates remain pending. Either re-call request_compaction (rate limit allowing) or yield with the evacuation as-is.`,
      withContinuationOwner({ sessionKey: params.sessionKey }, params.ownerAgentId),
    );
  } catch (err) {
    log.error(
      `[request_compaction:failure-event-error] session=${params.sessionKey} runId=${params.runId ?? params.sessionId} ` +
        `diagId=${params.diagId} code=${params.code} error=${formatErrorMessage(err)}`,
    );
  }
}

function notifyCompactionDegraded(params: {
  enqueue: typeof enqueueSystemEvent;
  sessionKey: string;
  ownerAgentId?: string;
  runId?: string;
  sessionId?: string;
  diagId: string;
}): void {
  try {
    params.enqueue(
      `[system:compaction-degraded] Volitional compaction request ${params.diagId} committed a degraded summary: it failed its quality audit and was kept so the session can shrink. Older details, exact identifiers, or pending requests may be missing. Re-establish anything important from your evacuated state before relying on it.`,
      withContinuationOwner({ sessionKey: params.sessionKey }, params.ownerAgentId),
    );
  } catch (err) {
    log.error(
      `[request_compaction:degraded-event-error] session=${params.sessionKey} runId=${params.runId ?? params.sessionId} ` +
        `diagId=${params.diagId} error=${formatErrorMessage(err)}`,
    );
  }
}

/**
 * The guards a request must clear before compaction is enqueued. Exported so the
 * context-pressure cue reads this verdict instead of a copy of it. Guards run in
 * order; a rejection carries the structured result the tool returns.
 */
export function evaluateRequestCompactionGuards(params: {
  sessionKey: string;
  getContextUsage: RequestCompactionToolOpts["getContextUsage"];
  contextUsageOrigin?: RequestCompactionToolOpts["contextUsageOrigin"];
}):
  | { admitted: true; contextUsage: number }
  | { admitted: false; rejection: Record<string, unknown> } {
  const { sessionKey } = params;

  // ----- Guard 0: Dedup — compaction already pending -----
  if (pendingCompactionSessions.has(sessionKey)) {
    log.debug(`[request_compaction:already-pending] session=${sessionKey}`);
    return {
      admitted: false,
      rejection: {
        status: "already_pending",
        reason: "A compaction request is already in-flight for this session.",
      },
    };
  }

  // ----- Guard 1: Context threshold -----
  const contextUsage = params.getContextUsage();
  if (typeof contextUsage !== "number") {
    // A named cause always wins; a bare null is only inventory-only off a live runner.
    const cause =
      contextUsage ??
      (params.contextUsageOrigin === "live_runner" ? "no_fresh_usage" : "inventory_only");
    log.debug(`[request_compaction:context-unmeasured] session=${sessionKey} cause=${cause}`);
    return {
      admitted: false,
      rejection: {
        status: "rejected",
        guard: "context_unmeasured",
        cause,
        reason: UNMEASURED_REASONS[cause],
      },
    };
  }
  if (contextUsage < MIN_CONTEXT_THRESHOLD) {
    log.debug(
      `[request_compaction:below-threshold] session=${sessionKey} usage=${(contextUsage * 100).toFixed(1)}%`,
    );
    return {
      admitted: false,
      rejection: {
        status: "rejected",
        guard: "context_threshold",
        contextUsage: Math.round(contextUsage * 100),
        threshold: Math.round(MIN_CONTEXT_THRESHOLD * 100),
        reason: `Context usage (${Math.round(contextUsage * 100)}%) is below the minimum threshold (${Math.round(MIN_CONTEXT_THRESHOLD * 100)}%). Compaction is not needed yet.`,
      },
    };
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
    return {
      admitted: false,
      rejection: {
        status: "rejected",
        guard: "rate_limit",
        retryAfterSeconds: remainingSec,
        reason: `Rate limited. Next compaction request allowed in ${remainingSec}s.`,
      },
    };
  }

  return { admitted: true, contextUsage };
}

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
 *   - **Context threshold:** context usage must be measured and >= 70%.
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
    description: [
      "Trigger compaction volitionally — but FIRST stage working-state survival via continue_delegate(mode='post-compaction', task='<state-summary>'), THEN call this — vs becoming subject to forced compaction at context exhaustion with no warning.",
      "Working state is NOT preserved automatically — the paired post-compaction delegate is what carries state across the seam, and you must stage it before requesting compaction.",
      "Typically called after receiving a [system:context-pressure] event, which fires as your context approaches compaction.",
      "Reach for this when you've felt context pressure and want to land compaction at a chosen moment rather than obligatorily at context exhaustion, which may occur mid-thought or otherwise be inopportune.",
      "Async: enqueues compaction; runs after this turn completes — safe to call mid-turn.",
      "Guards return as structured rejections (not errors): requires >=70% context usage and at most one request per 5 minutes per session.",
    ].join(" "),
    parameters: RequestCompactionToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("request_compaction arguments must be an object.");
      }
      const params = args;
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

      const reasonText = readToolStringParam(params, "reason", { required: true }).slice(0, 1024);
      const focusText = readToolStringParam(params, "focus")?.slice(0, 4096);
      const traceparent = formatCurrentSpanContinuationTraceparent();
      const traceContextFields = traceparent ? { traceparent } : {};

      const guards = evaluateRequestCompactionGuards({
        sessionKey,
        getContextUsage: opts.getContextUsage,
        contextUsageOrigin: opts.contextUsageOrigin,
      });
      if (!guards.admitted) {
        return jsonResult(guards.rejection);
      }
      const { contextUsage } = guards;
      const now = Date.now();
      const diagId = createCompactionDiagId(now);

      // ----- All guards passed — enqueue compaction -----
      // No generation guard (removed 2026-04-15 RFC): compaction is not blocked
      // by unrelated channel activity.
      log.info(
        `[request_compaction:enqueuing] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
          `diagId=${diagId} trigger=volitional usage=${(contextUsage * 100).toFixed(1)}% reason=${reasonText}`,
      );

      // Fire-and-forget: compaction runs via the lane queue after the current
      // agent turn releases the session lane. We do NOT await — the tool
      // returns immediately so the agent can finish its response.
      pendingCompactionSessions.add(sessionKey);
      const request: RequestCompactionInvocation = {
        sessionKey,
        sessionId: opts.sessionId,
        ...(opts.runId ? { runId: opts.runId } : {}),
        diagId,
        trigger: "volitional",
        reason: reasonText,
        ...(focusText ? { customInstructions: focusText } : {}),
        contextUsage,
        requestedAtMs: now,
        ...traceContextFields,
      };
      const notifyFailure = (code: string, reason: string) =>
        notifyCompactionFailure({
          enqueue: opts.enqueueSystemEvent ?? enqueueSystemEvent,
          sessionKey,
          ownerAgentId: opts.ownerAgentId,
          runId: opts.runId,
          sessionId: opts.sessionId,
          diagId,
          code,
          reason,
        });
      let asyncCleanupRegistered = true;
      try {
        void opts
          .triggerCompaction(request)
          .then(
            (result) => {
              if (result.ok && result.compacted) {
                sessionGuardState.set(sessionKey, {
                  lastRequestMs: Date.now(),
                });
                log.info(
                  `[request_compaction:resolved-success] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
                    `diagId=${diagId} trigger=volitional outcome=compacted`,
                );
                incrementVolitionalCompactionCount(sessionKey);
                if (result.qualityDegraded) {
                  log.warn(
                    `[request_compaction:resolved-degraded] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
                      `diagId=${diagId} trigger=volitional outcome=compacted quality=degraded`,
                  );
                  notifyCompactionDegraded({
                    enqueue: opts.enqueueSystemEvent ?? enqueueSystemEvent,
                    sessionKey,
                    ownerAgentId: opts.ownerAgentId,
                    runId: opts.runId,
                    sessionId: opts.sessionId,
                    diagId,
                  });
                }
                return;
              }
              const code = classifyCompactionReason(result.reason);
              const resolvedReason = result.reason ?? "";
              if (result.ok && isCompactionSkipCode(code)) {
                log.info(
                  `[request_compaction:resolved-skip] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
                    `diagId=${diagId} trigger=volitional outcome=skipped code=${code} reason=${resolvedReason}`,
                );
                return;
              }
              log.warn(
                `[request_compaction:resolved-failure] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
                  `diagId=${diagId} trigger=volitional outcome=failed code=${code} ok=${result.ok} compacted=${result.compacted} reason=${resolvedReason}`,
              );
              notifyFailure(code, resolvedReason);
            },
            (err: unknown) => {
              const message = formatErrorMessage(err);
              const code = classifyCompactionReason(message);
              log.error(
                `[request_compaction:background-error] session=${sessionKey} runId=${opts.runId ?? opts.sessionId} ` +
                  `diagId=${diagId} trigger=volitional outcome=failed code=${code} error=${message}`,
              );
              notifyFailure(code, message);
            },
          )
          .finally(() => {
            pendingCompactionSessions.delete(sessionKey);
          });
      } catch {
        asyncCleanupRegistered = false;
      } finally {
        if (!asyncCleanupRegistered) {
          pendingCompactionSessions.delete(sessionKey);
        }
      }

      return jsonResult({
        status: "compaction_requested",
        compactionRequestId: diagId,
        trigger: "volitional",
        contextUsage: Math.round(contextUsage * 100),
        reason: reasonText,
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
  clock: () => Date.now(),
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
// oxlint-disable-next-line eslint/no-underscore-dangle -- test-only export
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
// oxlint-disable-next-line eslint/no-underscore-dangle -- test-only export
export function _setPending(sessionKey: string): void {
  pendingCompactionSessions.add(sessionKey);
}

/** Reset volitional compaction counters. Exported for tests only. */
// oxlint-disable-next-line eslint/no-underscore-dangle -- test-only export
export function _resetVolitionalCounts(sessionKey?: string): void {
  if (sessionKey) {
    volitionalCompactionCounts.delete(sessionKey);
  } else {
    volitionalCompactionCounts.clear();
  }
}

/** Expose constants for test assertions. */
// oxlint-disable-next-line eslint/no-underscore-dangle -- test-only export
export const _guards = {
  MIN_CONTEXT_THRESHOLD,
  RATE_LIMIT_MS,
  VOLITIONAL_COMPACTION_COUNT_TTL_MS,
} as const;
