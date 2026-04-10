// Octopus Orchestrator — Arm state machine (M1-07)
//
// Pure FSM module operating on a narrow `ArmStateLike` shape, decoupled
// from the storage layer. RegistryService composes FSM validation + CAS
// update at the call site:
//
//   const next = applyArmTransition(arm, "active", { arm_id });
//   registry.casUpdateArm(arm_id, expected, { state: next.state, updated_at: next.updated_at });
//
// State diagram is from LLD §State Machines (Arm state machine) and is
// the single source of truth. The transition table is encoded once as a
// ReadonlyMap; validArmTransition / applyArmTransition / getValidNextStates
// all derive from it. There is NO parallel switch statement — every
// reader of the FSM goes through the same map.
//
// archived is the absorbing terminal state per LLD: completed and
// terminated arms transition to archived after retention policy applies.
// archived has no outbound transitions.
//
// Cross-reference with arm.* event vocabulary in src/octo/wire/events.ts:
// every state transition corresponds 1:1 with an arm.* event type
// (arm.starting, arm.active, arm.idle, arm.blocked, arm.failed,
// arm.quarantined, arm.completed, arm.terminated, arm.archived). The
// arm.created event lands the arm in `pending` (the initial state); the
// arm.reattached and arm.recovered events do not change state — they
// re-bind a session to an existing arm row.

// ──────────────────────────────────────────────────────────────────────────
// Canonical state enum
// ──────────────────────────────────────────────────────────────────────────

export const ARM_STATES = [
  "pending",
  "starting",
  "active",
  "idle",
  "blocked",
  "failed",
  "quarantined",
  "completed",
  "terminated",
  "archived",
] as const;

export type ArmState = (typeof ARM_STATES)[number];

// ──────────────────────────────────────────────────────────────────────────
// Narrow shape — the FSM does not care about any arm fields beyond these.
// The `state` field is typed as `ArmState | string` to accept raw DB rows
// (registry.ts stores `state: string`); we validate before narrowing.
// ──────────────────────────────────────────────────────────────────────────

// `state` is typed as plain `string` to accept raw DB rows from the
// registry (which stores `state: string`). Internally we validate via
// `isArmState` before treating it as a narrowed `ArmState`.
export interface ArmStateLike {
  state: string;
  updated_at: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Transition table — SINGLE SOURCE OF TRUTH.
//
// Encoded once as a ReadonlyMap; all FSM primitives derive from it.
// Exported so tests can sweep the full 10x10 matrix against the same
// source map (no parallel hand-written list).
// ──────────────────────────────────────────────────────────────────────────

export const ARM_TRANSITIONS: ReadonlyMap<ArmState, ReadonlySet<ArmState>> = new Map<
  ArmState,
  ReadonlySet<ArmState>
>([
  ["pending", new Set<ArmState>(["starting"])],
  ["starting", new Set<ArmState>(["active", "failed"])],
  [
    "active",
    new Set<ArmState>(["idle", "blocked", "failed", "quarantined", "completed", "terminated"]),
  ],
  ["idle", new Set<ArmState>(["active", "completed", "failed", "terminated"])],
  ["blocked", new Set<ArmState>(["active", "failed", "quarantined", "terminated"])],
  ["failed", new Set<ArmState>(["starting", "quarantined", "terminated"])],
  ["quarantined", new Set<ArmState>(["starting", "terminated"])],
  ["completed", new Set<ArmState>(["archived"])],
  ["terminated", new Set<ArmState>(["archived"])],
  ["archived", new Set<ArmState>([])], // absorbing — no outbound transitions
]);

// ──────────────────────────────────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly arm_id?: string;

  constructor(from: string, to: string, arm_id?: string) {
    const armSuffix = arm_id ? ` (arm_id=${arm_id})` : "";
    super(`Invalid arm state transition: ${from} -> ${to}${armSuffix}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.arm_id = arm_id;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

/** Type guard: is this string a known ArmState? */
export function isArmState(value: string): value is ArmState {
  return ARM_TRANSITIONS.has(value as ArmState);
}

/**
 * Pure check — no side effects, no throws. Returns false for unknown
 * source or target states, and for same-state pairs (which are not in
 * any outbound set per the LLD diagram).
 */
export function validArmTransition(from: string, to: string): boolean {
  if (!isArmState(from) || !isArmState(to)) {
    return false;
  }
  const outbound = ARM_TRANSITIONS.get(from);
  return outbound !== undefined && outbound.has(to);
}

/**
 * Returns the set of states reachable from `from` in a single step.
 * For `archived` this is the empty set.
 */
export function getValidNextStates(from: ArmState): ReadonlySet<ArmState> {
  const outbound = ARM_TRANSITIONS.get(from);
  // The map is constructed with all 10 states as keys, so this should
  // always be defined for a typed ArmState input. Fall back defensively.
  return outbound ?? new Set<ArmState>();
}

/** Terminal (absorbing) state test. Only `archived` qualifies. */
export function isTerminalState(state: ArmState): boolean {
  const outbound = ARM_TRANSITIONS.get(state);
  return outbound !== undefined && outbound.size === 0;
}

/**
 * Returns a NEW object (does not mutate input). Throws
 * InvalidTransitionError on invalid transition.
 *
 * `updated_at` is set to `opts.now` if provided, else `Date.now()`.
 * Accepting an explicit `now` keeps tests deterministic without mocking
 * the global clock.
 */
export function applyArmTransition<T extends ArmStateLike>(
  arm: T,
  to: ArmState,
  opts?: { now?: number; arm_id?: string },
): T & { state: ArmState; updated_at: number } {
  const from = arm.state;
  if (!validArmTransition(from, to)) {
    throw new InvalidTransitionError(from, to, opts?.arm_id);
  }
  const now = opts?.now ?? Date.now();
  return {
    ...arm,
    state: to,
    updated_at: now,
  };
}
