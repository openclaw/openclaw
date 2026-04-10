// Octopus Orchestrator — Grip state machine (M1-08)
//
// Pure FSM module operating on a narrow `GripStateLike` shape, decoupled
// from the storage layer. RegistryService composes FSM validation + CAS
// update at the call site:
//
//   const next = applyGripTransition(grip, "running", { grip_id });
//   registry.casUpdateGrip(grip_id, expected, { state: next.state, updated_at: next.updated_at });
//
// State diagram is from LLD §State Machines (Grip state machine) at line
// 318 and is the single source of truth. The transition table is encoded
// once as a ReadonlyMap; validGripTransition / applyGripTransition /
// getValidNextStates all derive from it. There is NO parallel switch
// statement — every reader of the FSM goes through the same map.
//
// Terminal (absorbing) states: BOTH `abandoned` AND `archived`. `archived`
// is the post-retention final state for completed grips; `abandoned` is
// where unrecoverable failed grips go (retry budget exhausted, operator
// give-up). Neither has any outbound transitions. Note this differs from
// the Arm FSM where only `archived` is terminal — arm's `terminated` is
// an operator-killed state that still transitions to archived, while
// grip's `abandoned` is a true dead-end.
//
// The `failed` state has TWO valid outbound paths: retry (`-> queued`)
// and give-up (`-> abandoned`). The policy layer (not the FSM) decides
// which based on retry budget and failure classification.
//
// Cross-reference with grip.* event vocabulary in src/octo/wire/events.ts:
// the FSM transitions correspond 1:1 with 7 of the 8 grip.* events.
// `grip.created` lands the grip in `queued` (the initial state) — the FSM
// does not model the creation transition because there is no `from`.
// `grip.ambiguous` is a SCHEDULER ANOMALY event, NOT a state transition:
// it is emitted when the scheduler cannot deterministically resolve grip
// ownership, and the grip's own state does not change. It therefore does
// not appear in this FSM.

// ──────────────────────────────────────────────────────────────────────────
// Canonical state enum
// ──────────────────────────────────────────────────────────────────────────

export const GRIP_STATES = [
  "queued",
  "assigned",
  "running",
  "blocked",
  "failed",
  "completed",
  "abandoned",
  "archived",
] as const;

export type GripState = (typeof GRIP_STATES)[number];

// ──────────────────────────────────────────────────────────────────────────
// Narrow shape — the FSM does not care about any grip fields beyond these.
// The `state` field is typed as `GripState | string` to accept raw DB rows
// (registry.ts stores `state: string`); we validate before narrowing.
// Keeping this narrow keeps the FSM pure and decoupled from storage.
// ──────────────────────────────────────────────────────────────────────────

// `state` is typed as plain `string` to accept raw DB rows from the
// registry (which stores `state: string`). Internally we validate via
// `isGripState` before treating it as a narrowed `GripState`.
export interface GripStateLike {
  state: string;
  updated_at: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Transition table — SINGLE SOURCE OF TRUTH.
//
// Encoded once as a ReadonlyMap; all FSM primitives derive from it.
// Exported so tests can sweep the full 8x8 matrix against the same source
// map (no parallel hand-written list).
// ──────────────────────────────────────────────────────────────────────────

export const GRIP_TRANSITIONS: ReadonlyMap<GripState, ReadonlySet<GripState>> = new Map<
  GripState,
  ReadonlySet<GripState>
>([
  ["queued", new Set<GripState>(["assigned"])],
  ["assigned", new Set<GripState>(["running"])],
  ["running", new Set<GripState>(["blocked", "failed", "completed"])],
  ["blocked", new Set<GripState>(["running", "failed"])],
  ["failed", new Set<GripState>(["queued", "abandoned"])],
  ["completed", new Set<GripState>(["archived"])],
  ["abandoned", new Set<GripState>([])], // absorbing — no outbound transitions
  ["archived", new Set<GripState>([])], // absorbing — no outbound transitions
]);

// ──────────────────────────────────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly grip_id?: string;

  constructor(from: string, to: string, grip_id?: string) {
    const gripSuffix = grip_id ? ` (grip_id=${grip_id})` : "";
    super(`Invalid grip state transition: ${from} -> ${to}${gripSuffix}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.grip_id = grip_id;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

/** Type guard: is this string a known GripState? */
export function isGripState(value: string): value is GripState {
  return GRIP_TRANSITIONS.has(value as GripState);
}

/**
 * Pure check — no side effects, no throws. Returns false for unknown
 * source or target states, and for same-state pairs (which are not in any
 * outbound set per the LLD diagram).
 */
export function validGripTransition(from: string, to: string): boolean {
  if (!isGripState(from) || !isGripState(to)) {
    return false;
  }
  const outbound = GRIP_TRANSITIONS.get(from);
  return outbound !== undefined && outbound.has(to);
}

/**
 * Returns the set of states reachable from `from` in a single step.
 * For `abandoned` and `archived` this is the empty set.
 */
export function getValidNextStates(from: GripState): ReadonlySet<GripState> {
  const outbound = GRIP_TRANSITIONS.get(from);
  // The map is constructed with all 8 states as keys, so this should
  // always be defined for a typed GripState input. Fall back defensively.
  return outbound ?? new Set<GripState>();
}

/**
 * Terminal (absorbing) state test. BOTH `abandoned` and `archived`
 * qualify — neither has any outbound transitions.
 */
export function isTerminalState(state: GripState): boolean {
  const outbound = GRIP_TRANSITIONS.get(state);
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
export function applyGripTransition<T extends GripStateLike>(
  grip: T,
  to: GripState,
  opts?: { now?: number; grip_id?: string },
): T & { state: GripState; updated_at: number } {
  const from = grip.state;
  if (!validGripTransition(from, to)) {
    throw new InvalidTransitionError(from, to, opts?.grip_id);
  }
  const now = opts?.now ?? Date.now();
  return {
    ...grip,
    state: to,
    updated_at: now,
  };
}
