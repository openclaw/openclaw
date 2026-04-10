// Octopus Orchestrator — Mission FSM tests (M1-09)
//
// The transition matrix sweep is the load-bearing acceptance criterion:
// every valid transition ok, every invalid transition throws. Test cases
// are GENERATED from the same MISSION_TRANSITIONS map the implementation
// uses, so drift between the derived diagram, the map, and the tests is
// impossible by construction.
//
// Unlike Arm/Grip, the LLD has no dedicated Mission state diagram — the
// FSM is derived from the mission.* event vocabulary and operational
// semantics (see mission-fsm.ts header). A dedicated spot-check test
// pins the `paused → completed` rejection so any future relaxation is
// an intentional change, not a silent drift.

import { describe, expect, it } from "vitest";
import {
  applyMissionTransition,
  getValidNextStates,
  InvalidTransitionError,
  isMissionState,
  isTerminalState,
  MISSION_STATES,
  MISSION_TRANSITIONS,
  validMissionTransition,
  type MissionState,
  type MissionStateLike,
} from "./mission-fsm.ts";

// ──────────────────────────────────────────────────────────────────────────
// Sweep helpers — generated from the single source of truth
// ──────────────────────────────────────────────────────────────────────────

const allTransitionPairs: [MissionState, MissionState][] = [];
for (const from of MISSION_STATES) {
  for (const to of MISSION_STATES) {
    allTransitionPairs.push([from, to]);
  }
}

const validPairs = allTransitionPairs.filter(
  ([f, t]) => MISSION_TRANSITIONS.get(f)?.has(t) ?? false,
);
const invalidPairs = allTransitionPairs.filter(
  ([f, t]) => !(MISSION_TRANSITIONS.get(f)?.has(t) ?? false),
);

function makeMission(state: MissionState | string, updated_at = 1_000): MissionStateLike {
  return { state, updated_at };
}

// ──────────────────────────────────────────────────────────────────────────
// Enum / table integrity
// ──────────────────────────────────────────────────────────────────────────

describe("MISSION_STATES", () => {
  it("has exactly 5 entries", () => {
    expect(MISSION_STATES).toHaveLength(5);
  });

  it("contains every LLD-listed state name verbatim", () => {
    expect(new Set<string>(MISSION_STATES)).toEqual(
      new Set<string>(["active", "paused", "completed", "aborted", "archived"]),
    );
  });
});

describe("MISSION_TRANSITIONS", () => {
  it("covers all 5 states as keys", () => {
    for (const state of MISSION_STATES) {
      expect(MISSION_TRANSITIONS.has(state)).toBe(true);
    }
    expect(MISSION_TRANSITIONS.size).toBe(MISSION_STATES.length);
  });

  it("has archived as absorbing terminal state (empty outbound set)", () => {
    expect(MISSION_TRANSITIONS.get("archived")?.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validMissionTransition — full 5x5 sweep
// ──────────────────────────────────────────────────────────────────────────

describe("validMissionTransition", () => {
  it.each(validPairs)("valid: %s -> %s returns true", (from, to) => {
    expect(validMissionTransition(from, to)).toBe(true);
  });

  it.each(invalidPairs)("invalid: %s -> %s returns false", (from, to) => {
    expect(validMissionTransition(from, to)).toBe(false);
  });

  it("rejects unknown source state", () => {
    expect(validMissionTransition("fictional", "active")).toBe(false);
  });

  it("rejects unknown target state", () => {
    expect(validMissionTransition("active", "fictional")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyMissionTransition — full sweep
// ──────────────────────────────────────────────────────────────────────────

describe("applyMissionTransition", () => {
  it.each(validPairs)("valid: %s -> %s produces updated mission", (from, to) => {
    const mission = makeMission(from, 1_000);
    const next = applyMissionTransition(mission, to, { now: 2_000 });
    expect(next.state).toBe(to);
    expect(next.updated_at).toBe(2_000);
  });

  it.each(invalidPairs)("invalid: %s -> %s throws InvalidTransitionError", (from, to) => {
    const mission = makeMission(from);
    let caught: unknown;
    try {
      applyMissionTransition(mission, to, { now: 2_000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const err = caught as InvalidTransitionError;
    expect(err.from).toBe(from);
    expect(err.to).toBe(to);
  });

  it("does not mutate the input mission", () => {
    const mission = makeMission("active", 1_000);
    const snapshot = { ...mission };
    applyMissionTransition(mission, "paused", { now: 2_000 });
    expect(mission).toEqual(snapshot);
  });

  it("same-state transition (active -> active) throws", () => {
    const mission = makeMission("active");
    expect(() => applyMissionTransition(mission, "active")).toThrow(InvalidTransitionError);
  });

  it("unknown source state throws", () => {
    const mission = makeMission("fictional");
    expect(() => applyMissionTransition(mission, "active")).toThrow(InvalidTransitionError);
  });

  it("unknown target state throws", () => {
    const mission = makeMission("active");
    expect(() => applyMissionTransition(mission, "fictional" as MissionState)).toThrow(
      InvalidTransitionError,
    );
  });

  it("explicit `now` option is used as updated_at", () => {
    const mission = makeMission("active", 1);
    const next = applyMissionTransition(mission, "paused", {
      now: 1_700_000_000_000,
    });
    expect(next.updated_at).toBe(1_700_000_000_000);
  });

  it("falls back to Date.now() when opts.now is omitted", () => {
    const before = Date.now();
    const mission = makeMission("active", 1);
    const next = applyMissionTransition(mission, "paused");
    const after = Date.now();
    expect(next.updated_at).toBeGreaterThanOrEqual(before);
    expect(next.updated_at).toBeLessThanOrEqual(after);
  });

  it("mission_id option is included on the thrown error", () => {
    const mission = makeMission("archived");
    let caught: unknown;
    try {
      applyMissionTransition(mission, "active", {
        mission_id: "test-mission",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const err = caught as InvalidTransitionError;
    expect(err.mission_id).toBe("test-mission");
    expect(err.message).toContain("test-mission");
  });

  it("preserves extra fields on a wider mission-like record", () => {
    interface WiderMission extends MissionStateLike {
      mission_id: string;
      version: number;
    }
    const mission: WiderMission = {
      mission_id: "mission-123",
      version: 7,
      state: "active",
      updated_at: 1_000,
    };
    const next = applyMissionTransition(mission, "paused", { now: 2_000 });
    expect(next.mission_id).toBe("mission-123");
    expect(next.version).toBe(7);
    expect(next.state).toBe("paused");
    expect(next.updated_at).toBe(2_000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

describe("getValidNextStates", () => {
  it.each(MISSION_STATES)("%s: returned set matches MISSION_TRANSITIONS", (state) => {
    const expected = MISSION_TRANSITIONS.get(state);
    const actual = getValidNextStates(state);
    expect(actual).toBe(expected);
  });
});

describe("isTerminalState", () => {
  it.each(MISSION_STATES)("%s: correct terminal status", (state) => {
    expect(isTerminalState(state)).toBe(state === "archived");
  });

  it("completed is NOT terminal (still has -> archived edge)", () => {
    expect(isTerminalState("completed")).toBe(false);
  });

  it("aborted is NOT terminal (still has -> archived edge)", () => {
    expect(isTerminalState("aborted")).toBe(false);
  });
});

describe("isMissionState", () => {
  it.each(MISSION_STATES)("%s is a valid MissionState", (state) => {
    expect(isMissionState(state)).toBe(true);
  });

  it.each(["", "fictional", "ACTIVE", "Paused", "mission.active"])(
    "%s is NOT a valid MissionState",
    (bogus) => {
      expect(isMissionState(bogus)).toBe(false);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Error class
// ──────────────────────────────────────────────────────────────────────────

describe("InvalidTransitionError", () => {
  it("is an Error subclass with name 'InvalidTransitionError'", () => {
    const err = new InvalidTransitionError("active", "archived");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.name).toBe("InvalidTransitionError");
    expect(err.from).toBe("active");
    expect(err.to).toBe("archived");
    expect(err.mission_id).toBeUndefined();
  });

  it("message includes mission_id when provided", () => {
    const err = new InvalidTransitionError("active", "archived", "mission-xyz");
    expect(err.message).toContain("active -> archived");
    expect(err.message).toContain("mission-xyz");
    expect(err.mission_id).toBe("mission-xyz");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Judgment-call pin: paused -> completed is INVALID
// ──────────────────────────────────────────────────────────────────────────
//
// The LLD does not explicitly forbid this edge, but the FSM rejects it.
// Rationale: completion is a property of a running mission; a paused
// mission must be resumed (paused -> active) or aborted
// (paused -> aborted) before it can complete. The mission.completed
// event has no operational meaning on a paused mission. This test pins
// the rejection so a future relaxation is intentional rather than
// silent drift. See the mission-fsm.ts header for the full reasoning.

describe("judgment call: paused -> completed rejection", () => {
  it("paused -> completed is NOT a valid transition (must resume first)", () => {
    expect(validMissionTransition("paused", "completed")).toBe(false);
  });

  it("paused -> completed throws InvalidTransitionError", () => {
    const mission = makeMission("paused");
    expect(() => applyMissionTransition(mission, "completed")).toThrow(InvalidTransitionError);
  });

  it("paused -> archived is also NOT a valid transition", () => {
    expect(validMissionTransition("paused", "archived")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Operator paths spot check
// ──────────────────────────────────────────────────────────────────────────

describe("operator paths", () => {
  it("active -> aborted is valid (operator aborts running mission)", () => {
    expect(validMissionTransition("active", "aborted")).toBe(true);
  });

  it("paused -> aborted is valid (operator aborts paused mission)", () => {
    expect(validMissionTransition("paused", "aborted")).toBe(true);
  });

  it("aborted -> archived is valid (retention policy)", () => {
    expect(validMissionTransition("aborted", "archived")).toBe(true);
  });

  it("completed -> archived is valid (retention policy)", () => {
    expect(validMissionTransition("completed", "archived")).toBe(true);
  });

  it("paused -> active is valid (resume)", () => {
    expect(validMissionTransition("paused", "active")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Sanity: valid transition count matches the derived diagram
// ──────────────────────────────────────────────────────────────────────────

describe("transition table sanity", () => {
  it("has exactly 7 valid transitions per the derived diagram", () => {
    // active(3) + paused(2) + completed(1) + aborted(1) + archived(0) = 7
    let count = 0;
    for (const [, outbound] of MISSION_TRANSITIONS) {
      count += outbound.size;
    }
    expect(count).toBe(7);
    expect(validPairs).toHaveLength(count);
  });
});
