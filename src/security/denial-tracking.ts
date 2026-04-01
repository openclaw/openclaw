/**
 * Denial Tracking - Tracks consecutive and total denials to prevent bypass attempts.
 *
 * Inspired by Claude Code's denial tracking mechanism.
 * This module prevents LLMs from repeatedly attempting variations of blocked commands
 * to bypass security checks.
 *
 * @see https://github.com/anthropics/claude-code - Reference implementation
 */

export type DenialTrackingState = {
  /** Number of consecutive denials since last successful operation */
  consecutiveDenials: number;
  /** Total number of denials in this session */
  totalDenials: number;
  /** Timestamp of last denial */
  lastDenialAt: number;
  /** Timestamp of last successful operation */
  lastSuccessAt: number;
};

export type DenialLimits = {
  /** Maximum consecutive denials before escalating (e.g., abort or force manual approval) */
  maxConsecutive: number;
  /** Maximum total denials in a session before aborting */
  maxTotal: number;
  /** Optional cooldown period in ms after hitting limits */
  cooldownMs?: number;
};

/**
 * Default denial limits.
 * These are conservative defaults that balance security with usability.
 */
export const DEFAULT_DENIAL_LIMITS: Readonly<DenialLimits> = {
  maxConsecutive: 3,
  maxTotal: 20,
  cooldownMs: 5000,
} as const;

/**
 * Create initial denial tracking state.
 */
export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
    lastDenialAt: 0,
    lastSuccessAt: Date.now(),
  };
}

/**
 * Record a denial event.
 * Returns a new state object (immutable update).
 */
export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
    lastDenialAt: Date.now(),
  };
}

/**
 * Record a successful operation.
 * Resets consecutive denial count but preserves total count.
 */
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) {
    return state; // No change needed
  }
  return {
    ...state,
    consecutiveDenials: 0,
    lastSuccessAt: Date.now(),
  };
}

/**
 * Check if denial limits have been exceeded.
 */
export function isDenialLimitExceeded(
  state: DenialTrackingState,
  limits: DenialLimits = DEFAULT_DENIAL_LIMITS,
): { exceeded: boolean; reason?: "consecutive" | "total" } {
  if (state.consecutiveDenials >= limits.maxConsecutive) {
    return { exceeded: true, reason: "consecutive" };
  }
  if (state.totalDenials >= limits.maxTotal) {
    return { exceeded: true, reason: "total" };
  }
  return { exceeded: false };
}

/**
 * Check if we should fallback to manual prompting due to denial limits.
 * In headless/async mode, this should trigger an abort instead.
 */
export function shouldFallbackToPrompting(
  state: DenialTrackingState,
  limits: DenialLimits = DEFAULT_DENIAL_LIMITS,
): boolean {
  return isDenialLimitExceeded(state, limits).exceeded;
}

/**
 * Check if cooldown period is active after hitting limits.
 */
export function isCooldownActive(
  state: DenialTrackingState,
  limits: DenialLimits = DEFAULT_DENIAL_LIMITS,
): boolean {
  if (!limits.cooldownMs || limits.cooldownMs <= 0) {
    return false;
  }
  const limitExceeded = isDenialLimitExceeded(state, limits);
  if (!limitExceeded.exceeded) {
    return false;
  }
  const elapsed = Date.now() - state.lastDenialAt;
  return elapsed < limits.cooldownMs;
}

/**
 * Get a human-readable denial status message.
 */
export function getDenialStatusMessage(
  state: DenialTrackingState,
  limits: DenialLimits = DEFAULT_DENIAL_LIMITS,
): string | null {
  const limitExceeded = isDenialLimitExceeded(state, limits);
  if (!limitExceeded.exceeded) {
    return null;
  }

  if (limitExceeded.reason === "total") {
    return `${state.totalDenials} operations were blocked this session. Please review the transcript before continuing.`;
  }

  return `${state.consecutiveDenials} consecutive operations were blocked. Please review the transcript before continuing.`;
}

/**
 * Reset denial tracking state (e.g., after user acknowledges warnings).
 * Only resets consecutive count; total count persists for session awareness.
 */
export function resetConsecutiveDenials(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: 0,
  };
}

/**
 * Fully reset denial tracking state (e.g., for new session).
 */
export function resetDenialTrackingState(): DenialTrackingState {
  return createDenialTrackingState();
}

// Per-agent denial tracking storage
const agentDenialStates = new Map<string, DenialTrackingState>();

/**
 * Get denial tracking state for an agent.
 * Creates a new state if one doesn't exist.
 */
export function getAgentDenialState(agentId: string): DenialTrackingState {
  let state = agentDenialStates.get(agentId);
  if (!state) {
    state = createDenialTrackingState();
    agentDenialStates.set(agentId, state);
  }
  return state;
}

/**
 * Update denial tracking state for an agent.
 */
export function setAgentDenialState(agentId: string, state: DenialTrackingState): void {
  agentDenialStates.set(agentId, state);
}

/**
 * Record a denial for an agent.
 */
export function recordAgentDenial(agentId: string): DenialTrackingState {
  const state = getAgentDenialState(agentId);
  const newState = recordDenial(state);
  setAgentDenialState(agentId, newState);
  return newState;
}

/**
 * Record a success for an agent.
 */
export function recordAgentSuccess(agentId: string): DenialTrackingState {
  const state = getAgentDenialState(agentId);
  const newState = recordSuccess(state);
  setAgentDenialState(agentId, newState);
  return newState;
}

/**
 * Clear denial tracking state for an agent.
 */
export function clearAgentDenialState(agentId: string): void {
  agentDenialStates.delete(agentId);
}

/**
 * Clear all denial tracking states.
 */
export function clearAllDenialStates(): void {
  agentDenialStates.clear();
}
