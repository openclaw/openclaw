/**
 * Gateway-level bridge for the policy feedback subsystem.
 *
 * Provides singleton access to the policy engine from gateway subsystems
 * (auto-reply, heartbeat, cron, prompt builder) without requiring them to
 * import the engine directly or manage lifecycle.
 *
 * The bridge is set during gateway initialization and cleared on shutdown.
 * All accessor functions are safe to call when the engine is not available
 * (they return no-op defaults).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatPolicyHintsForPrompt } from "./prompt-hints.js";
import type { PolicyContext, PolicyFeedbackEngine, PolicyHints, PolicyMode } from "./types.js";

const log = createSubsystemLogger("policy-feedback:bridge");

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _engine: PolicyFeedbackEngine | null = null;
let _mode: PolicyMode = "off";

/** Set the active engine. Called once during gateway init. */
export function setPolicyFeedbackEngine(engine: PolicyFeedbackEngine | null, mode: PolicyMode): void {
  _engine = engine;
  _mode = mode;
  log.debug("policy feedback bridge configured", { mode, hasEngine: engine !== null });
}

/** Clear the engine on shutdown. */
export function clearPolicyFeedbackEngine(): void {
  _engine = null;
  _mode = "off";
}

/** Check if the policy feedback subsystem is active (not off). */
export function isPolicyFeedbackActive(): boolean {
  return _engine !== null && _mode !== "off";
}

/** Get the current policy mode. */
export function getPolicyFeedbackMode(): PolicyMode {
  return _mode;
}

// ---------------------------------------------------------------------------
// High-level accessors for gateway subsystems
// ---------------------------------------------------------------------------

const DEFAULT_HINTS: PolicyHints = {
  recommendation: "proceed",
  reasons: [],
  fatigueLevel: 0,
  activeConstraints: [],
  mode: "off",
};

/**
 * Get policy hints for the current context. Safe to call when engine is null.
 * Returns default "proceed" hints when the subsystem is unavailable.
 */
export async function getPolicyHintsSafe(input: {
  agentId: string;
  sessionKey: string;
  channelId: string;
  context?: PolicyContext;
}): Promise<PolicyHints> {
  if (!_engine) {
    return DEFAULT_HINTS;
  }
  try {
    return await _engine.getPolicyHints(input);
  } catch {
    return DEFAULT_HINTS;
  }
}

/**
 * Get policy hints formatted as a system prompt section.
 * Returns undefined when the subsystem is off, passive, or has nothing to say.
 */
export async function getPolicyHintsForPrompt(input: {
  agentId: string;
  sessionKey: string;
  channelId: string;
  hourOfDay?: number;
  recentActionCount?: number;
  consecutiveIgnores?: number;
}): Promise<string | undefined> {
  if (!_engine || _mode === "off" || _mode === "passive") {
    return undefined;
  }
  try {
    const hints = await _engine.getPolicyHints({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      channelId: input.channelId,
      context: {
        channelId: input.channelId,
        hourOfDay: input.hourOfDay,
        recentActionCount: input.recentActionCount,
        consecutiveIgnores: input.consecutiveIgnores,
      },
    });
    return formatPolicyHintsForPrompt(hints);
  } catch {
    return undefined;
  }
}

/**
 * Log a meaningful action. Safe to call when engine is null. Fire-and-forget.
 */
export function logPolicyAction(input: {
  agentId: string;
  sessionKey: string;
  actionType: "agent_reply" | "tool_call" | "cron_run" | "heartbeat_run" | "no_op" | "suppressed";
  channelId: string;
  accountId?: string;
  contextSummary?: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!_engine) {
    return;
  }
  _engine.logAction(input).catch(() => {});
}
