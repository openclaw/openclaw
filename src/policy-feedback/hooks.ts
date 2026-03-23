/**
 * Hook integration bridge for the policy feedback subsystem.
 *
 * Registers internal hook handlers that feed action and outcome data
 * into the PolicyFeedbackEngine. All handlers are fire-and-forget and
 * wrapped in try/catch so they never disrupt the main message flow.
 *
 * Usage:
 *   const engine = await createPolicyFeedbackEngine({ ... });
 *   const unsub = registerPolicyFeedbackHooks(engine);
 *   // later: unsub() to detach all hooks
 */

import {
  type InternalHookEvent,
  isMessageReceivedEvent,
  isMessageSentEvent,
  registerInternalHook,
  unregisterInternalHook,
} from "../hooks/internal-hooks.js";
import { featureFlagsForMode } from "./config.js";
import type { PolicyFeedbackEngine, PolicyMode } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory pending-action map for correlating received -> sent
// ---------------------------------------------------------------------------

/** Tracks pending inbound messages awaiting agent reply confirmation. */
type PendingAction = {
  sessionKey: string;
  channelId: string;
  from: string;
  receivedAt: number;
  accountId?: string;
  conversationId?: string;
};

const pendingActions = new Map<string, PendingAction>();

// Track recent confirmed actions for outcome correlation (user replied -> prior agent action)
type ConfirmedAction = {
  actionId: string;
  sessionKey: string;
  channelId: string;
  sentAt: number;
  correlated: boolean;
};

const recentConfirmedActions = new Map<string, ConfirmedAction[]>();

/** Max confirmed actions to keep per session for correlation. */
const MAX_CONFIRMED_PER_SESSION = 20;

/** Max age for correlation lookback (24 hours). */
const MAX_CORRELATION_AGE_MS = 86_400_000;

/** Max pending actions per session before oldest are evicted. */
export const MAX_PENDING_PER_SESSION = 50;

/** TTL for pending actions — entries older than this are stale (5 minutes). */
export const MAX_PENDING_AGE_MS = 300_000;

/** Hard cap on total pendingActions map size to bound memory. */
const MAX_TOTAL_PENDING = 1000;

/**
 * Evict stale entries from `pendingActions` (older than MAX_PENDING_AGE_MS)
 * and enforce the MAX_TOTAL_PENDING hard cap by dropping oldest entries.
 *
 * Fire-and-forget safe — never throws.
 */
function pruneStalePendingActions(): void {
  try {
    const now = Date.now();
    for (const [key, entry] of pendingActions) {
      if (now - entry.receivedAt > MAX_PENDING_AGE_MS) {
        pendingActions.delete(key);
      }
    }

    // Hard cap: if still over limit, drop oldest entries first
    if (pendingActions.size > MAX_TOTAL_PENDING) {
      const sorted = [...pendingActions.entries()].toSorted(
        (a, b) => a[1].receivedAt - b[1].receivedAt,
      );
      const toRemove = sorted.length - MAX_TOTAL_PENDING;
      for (let i = 0; i < toRemove; i++) {
        pendingActions.delete(sorted[i][0]);
      }
    }
  } catch {
    // Fire-and-forget: never disrupt the main flow
  }
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

function createMessageReceivedHandler(
  engine: PolicyFeedbackEngine,
  getMode: () => PolicyMode,
  agentId: string,
) {
  return async (event: InternalHookEvent): Promise<void> => {
    try {
      const flags = featureFlagsForMode(getMode());
      if (!flags.enableActionLogging && !flags.enableOutcomeLogging) {
        return;
      }

      if (!isMessageReceivedEvent(event)) {
        return;
      }

      pruneStalePendingActions();

      const { from, channelId, accountId, conversationId } = event.context;
      const sessionKey = event.sessionKey;

      // 1. Store pending action (will be promoted on message:sent).
      // Keyed by sessionKey — intentionally overwrites prior inbound for the
      // same session since the agent's reply correlates with the latest message.
      if (flags.enableActionLogging) {
        pendingActions.set(sessionKey, {
          sessionKey,
          channelId,
          from,
          receivedAt: Date.now(),
          accountId,
          conversationId,
        });
      }

      // 2. Correlate with prior agent actions (delayed outcome)
      if (flags.enableOutcomeLogging) {
        const sessionActions = recentConfirmedActions.get(sessionKey);
        if (sessionActions) {
          const now = Date.now();
          for (const action of sessionActions) {
            if (action.correlated) {
              continue;
            }
            const elapsed = now - action.sentAt;
            if (elapsed > MAX_CORRELATION_AGE_MS) {
              continue;
            }

            action.correlated = true;
            await engine.logOutcome({
              actionId: action.actionId,
              agentId,
              outcomeType: "user_replied",
              value: Math.min(1, 1 - elapsed / MAX_CORRELATION_AGE_MS),
              horizonMs: elapsed,
              metadata: { channelId: action.channelId },
            });
          }

          // Prune old entries
          const pruned = sessionActions.filter(
            (a) => !a.correlated && now - a.sentAt < MAX_CORRELATION_AGE_MS,
          );
          if (pruned.length > 0) {
            recentConfirmedActions.set(sessionKey, pruned);
          } else {
            recentConfirmedActions.delete(sessionKey);
          }
        }
      }
    } catch {
      // Fire-and-forget: never disrupt the main flow
    }
  };
}

function createMessageSentHandler(
  engine: PolicyFeedbackEngine,
  getMode: () => PolicyMode,
  agentId: string,
) {
  return async (event: InternalHookEvent): Promise<void> => {
    try {
      const flags = featureFlagsForMode(getMode());
      if (!flags.enableActionLogging && !flags.enableOutcomeLogging) {
        return;
      }

      if (!isMessageSentEvent(event)) {
        return;
      }

      pruneStalePendingActions();

      const { to, channelId, success, accountId } = event.context;
      const sessionKey = event.sessionKey;

      // Promote pending action to confirmed
      if (flags.enableActionLogging) {
        const pending = pendingActions.get(sessionKey);
        pendingActions.delete(sessionKey);

        const { actionId } = await engine.logAction({
          agentId,
          sessionKey,
          actionType: "agent_reply",
          channelId,
          accountId,
          contextSummary: `Reply to ${pending?.from ?? to}`,
          metadata: {
            to,
            hadPendingInbound: Boolean(pending),
          },
        });

        // Track for outcome correlation
        if (!recentConfirmedActions.has(sessionKey)) {
          recentConfirmedActions.set(sessionKey, []);
        }
        const list = recentConfirmedActions.get(sessionKey)!;
        list.push({
          actionId,
          sessionKey,
          channelId,
          sentAt: Date.now(),
          correlated: false,
        });
        // Cap the list size
        if (list.length > MAX_CONFIRMED_PER_SESSION) {
          list.splice(0, list.length - MAX_CONFIRMED_PER_SESSION);
        }

        // Log immediate delivery outcome
        if (flags.enableOutcomeLogging) {
          await engine.logOutcome({
            actionId,
            agentId,
            outcomeType: success ? "delivery_success" : "delivery_failure",
            value: success ? 1 : 0,
            metadata: { channelId },
          });
        }
      }
    } catch {
      // Fire-and-forget: never disrupt the main flow
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PolicyFeedbackHooksOptions = {
  /** The engine to feed events into. */
  engine: PolicyFeedbackEngine;
  /** Function returning the current policy mode (checked on every event). */
  getMode: () => PolicyMode;
  /** Default agent ID for logging. */
  agentId: string;
};

/**
 * Register policy feedback hooks on the internal hook system.
 *
 * Returns an unsubscribe function that removes all registered handlers.
 * Safe to call multiple times (each call creates independent handlers).
 */
export function registerPolicyFeedbackHooks(options: PolicyFeedbackHooksOptions): () => void {
  const { engine, getMode, agentId } = options;

  const onReceived = createMessageReceivedHandler(engine, getMode, agentId);
  const onSent = createMessageSentHandler(engine, getMode, agentId);

  registerInternalHook("message:received", onReceived);
  registerInternalHook("message:sent", onSent);

  return () => {
    unregisterInternalHook("message:received", onReceived);
    unregisterInternalHook("message:sent", onSent);
    // Clean up in-memory state
    pendingActions.clear();
    recentConfirmedActions.clear();
  };
}

/**
 * Clear all in-memory hook state. Useful for testing.
 */
export function clearPolicyFeedbackHookState(): void {
  pendingActions.clear();
  recentConfirmedActions.clear();
}
