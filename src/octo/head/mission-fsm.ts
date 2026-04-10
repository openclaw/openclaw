// Octopus Orchestrator — Mission state machine (M1-09)
//
// Pure FSM module operating on a narrow `MissionStateLike` shape,
// decoupled from the storage layer. RegistryService composes FSM
// validation + CAS update at the call site:
//
//   const next = applyMissionTransition(mission, "paused", { mission_id });
//   registry.casUpdateMission(mission_id, expected, {
//     state: next.state, updated_at: next.updated_at,
//   });
//
// Source of truth & derivation notes
// ──────────────────────────────────────────────────────────────────────
// Unlike Arm (LLD §State Machines, line 300) and Grip (LLD §State
// Machines, line 318), the LLD does NOT include a dedicated diagram for
// the Mission state machine. The five mission states
//   active, paused, completed, aborted, archived
// are listed only in §Core Domain Objects (MissionRecord, around line
// 20) as the `status` enum. This FSM is therefore derived from:
//
//   1. The mission.* event vocabulary in src/octo/wire/events.ts
//      (CoreEventTypeSchema), which has exactly six mission events:
//        mission.created   — entry edge into `active` (pre-created has
//                            no representation; not modelled as a
//                            state→state transition)
//        mission.paused    — active   -> paused
//        mission.resumed   — paused   -> active
//        mission.completed — active   -> completed
//        mission.aborted   — active   -> aborted
//                            paused   -> aborted  (operators may abort
//                            a paused mission directly)
//        mission.archived  — completed -> archived
//                            aborted  -> archived  (post-retention)
//
//   2. Operational semantics — archived is the absorbing terminal
//      state; completed & aborted are intermediate terminals that exit
//      to archived via the retention policy.
//
// Derived transition diagram (7 edges):
//
//   active    -> paused | completed | aborted
//   paused    -> active | aborted
//   completed -> archived
//   aborted   -> archived
//   archived  -> (absorbing)
//
// Judgment call — paused → completed is INVALID
// ──────────────────────────────────────────────────────────────────────
// The LLD does not explicitly forbid paused→completed or
// paused→archived, but this FSM rejects them. Rationale: completion is
// a property of a running mission; a paused mission must be resumed
// (paused→active) or aborted (paused→aborted) before it can reach a
// terminal. The mission.completed event has no operational meaning on
// a paused mission — the operator should resume first, then let it
// complete. This matches the event vocabulary (there is no
// "mission.completed-from-paused" shortcut). A dedicated test pins
// this rejection so any future relaxation is intentional, not silent.
//
// Narrow MissionStateLike shape
// ──────────────────────────────────────────────────────────────────────
// Same rationale as M1-07: the FSM only needs `state` and `updated_at`.
// Typing `state` as `MissionState | string` lets this accept raw
// registry rows (registry.ts stores `state: string`) without a
// pre-cast; we validate before narrowing.

// ──────────────────────────────────────────────────────────────────────────
// Canonical state enum
// ──────────────────────────────────────────────────────────────────────────

export const MISSION_STATES = ["active", "paused", "completed", "aborted", "archived"] as const;

export type MissionState = (typeof MISSION_STATES)[number];

// ──────────────────────────────────────────────────────────────────────────
// Narrow shape — the FSM does not care about any mission fields beyond
// these. `state` is typed as `MissionState | string` to accept raw DB
// rows; we validate before narrowing.
// ──────────────────────────────────────────────────────────────────────────

export interface MissionStateLike {
  state: string;
  updated_at: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Transition table — SINGLE SOURCE OF TRUTH.
//
// Encoded once as a ReadonlyMap; all FSM primitives derive from it.
// Exported so tests can sweep the full 5x5 matrix against the same
// source map (no parallel hand-written list).
// ──────────────────────────────────────────────────────────────────────────

export const MISSION_TRANSITIONS: ReadonlyMap<MissionState, ReadonlySet<MissionState>> = new Map<
  MissionState,
  ReadonlySet<MissionState>
>([
  ["active", new Set<MissionState>(["paused", "completed", "aborted"])],
  ["paused", new Set<MissionState>(["active", "aborted"])],
  ["completed", new Set<MissionState>(["archived"])],
  ["aborted", new Set<MissionState>(["archived"])],
  ["archived", new Set<MissionState>([])], // absorbing — no outbound transitions
]);

// ──────────────────────────────────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly mission_id?: string;

  constructor(from: string, to: string, mission_id?: string) {
    const suffix = mission_id ? ` (mission_id=${mission_id})` : "";
    super(`Invalid mission state transition: ${from} -> ${to}${suffix}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.mission_id = mission_id;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

/** Type guard: is this string a known MissionState? */
export function isMissionState(value: string): value is MissionState {
  return MISSION_TRANSITIONS.has(value as MissionState);
}

/**
 * Pure check — no side effects, no throws. Returns false for unknown
 * source or target states, and for same-state pairs (which are not in
 * any outbound set per the derived diagram).
 */
export function validMissionTransition(from: string, to: string): boolean {
  if (!isMissionState(from) || !isMissionState(to)) {
    return false;
  }
  const outbound = MISSION_TRANSITIONS.get(from);
  return outbound !== undefined && outbound.has(to);
}

/**
 * Returns the set of states reachable from `from` in a single step.
 * For `archived` this is the empty set.
 */
export function getValidNextStates(from: MissionState): ReadonlySet<MissionState> {
  const outbound = MISSION_TRANSITIONS.get(from);
  // The map is constructed with all 5 states as keys, so this should
  // always be defined for a typed MissionState input. Fall back
  // defensively.
  return outbound ?? new Set<MissionState>();
}

/**
 * Terminal (absorbing) state test. Only `archived` qualifies.
 *
 * Note: `completed` and `aborted` look terminal from an operator's
 * perspective, but they still have an outbound `→ archived` transition
 * (driven by the retention policy), so the FSM does not classify them
 * as terminal. This matches the M1-07 (Arm) convention.
 */
export function isTerminalState(state: MissionState): boolean {
  const outbound = MISSION_TRANSITIONS.get(state);
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
export function applyMissionTransition<T extends MissionStateLike>(
  mission: T,
  to: MissionState,
  opts?: { now?: number; mission_id?: string },
): T & { state: MissionState; updated_at: number } {
  const from = mission.state;
  if (!validMissionTransition(from, to)) {
    throw new InvalidTransitionError(from, to, opts?.mission_id);
  }
  const now = opts?.now ?? Date.now();
  return {
    ...mission,
    state: to,
    updated_at: now,
  };
}
