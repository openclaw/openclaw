// Octopus Orchestrator — Grip state machine tests (M1-08)
//
// Matrix-sweep tests generated from GRIP_TRANSITIONS so there is no
// parallel hand-written list — any drift in the source map is caught by
// the same assertions.

import { describe, expect, it } from "vitest";
import {
  applyGripTransition,
  getValidNextStates,
  GRIP_STATES,
  GRIP_TRANSITIONS,
  InvalidTransitionError,
  isGripState,
  isTerminalState,
  validGripTransition,
  type GripState,
  type GripStateLike,
} from "./grip-fsm.ts";

// ──────────────────────────────────────────────────────────────────────────
// Derived fixtures (all from the source map)
// ──────────────────────────────────────────────────────────────────────────

const VALID_PAIRS: Array<[GripState, GripState]> = [];
const INVALID_PAIRS: Array<[GripState, GripState]> = [];

for (const from of GRIP_STATES) {
  const outbound = GRIP_TRANSITIONS.get(from);
  if (outbound === undefined) {
    throw new Error(`missing outbound for ${from}`);
  }
  for (const to of GRIP_STATES) {
    if (outbound.has(to)) {
      VALID_PAIRS.push([from, to]);
    } else {
      INVALID_PAIRS.push([from, to]);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Source map shape
// ──────────────────────────────────────────────────────────────────────────

describe("GRIP_STATES / GRIP_TRANSITIONS shape", () => {
  it("has exactly 8 states", () => {
    expect(GRIP_STATES).toHaveLength(8);
    expect(new Set(GRIP_STATES).size).toBe(8);
  });

  it("names the 8 states verbatim from the LLD", () => {
    expect(GRIP_STATES).toEqual([
      "queued",
      "assigned",
      "running",
      "blocked",
      "failed",
      "completed",
      "abandoned",
      "archived",
    ]);
  });

  it("has all 8 states as keys in GRIP_TRANSITIONS (drift detection)", () => {
    expect(GRIP_TRANSITIONS.size).toBe(8);
    for (const s of GRIP_STATES) {
      expect(GRIP_TRANSITIONS.has(s)).toBe(true);
    }
  });

  it("encodes exactly 10 valid transitions per the LLD", () => {
    // queued->assigned (1)
    // assigned->running (1)
    // running->{blocked,failed,completed} (3)
    // blocked->{running,failed} (2)
    // failed->{queued,abandoned} (2)
    // completed->archived (1)
    // abandoned->{} (0)
    // archived->{} (0)
    // total = 10
    expect(VALID_PAIRS).toHaveLength(10);
  });

  it("encodes the exact LLD edge set", () => {
    const edgeStrings = new Set(VALID_PAIRS.map(([f, t]) => `${f}->${t}`));
    expect(edgeStrings).toEqual(
      new Set([
        "queued->assigned",
        "assigned->running",
        "running->blocked",
        "running->failed",
        "running->completed",
        "blocked->running",
        "blocked->failed",
        "failed->queued",
        "failed->abandoned",
        "completed->archived",
      ]),
    );
  });

  it("has empty outbound sets for both absorbing states", () => {
    expect(GRIP_TRANSITIONS.get("abandoned")?.size).toBe(0);
    expect(GRIP_TRANSITIONS.get("archived")?.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// isGripState
// ──────────────────────────────────────────────────────────────────────────

describe("isGripState", () => {
  it("accepts every known state", () => {
    for (const s of GRIP_STATES) {
      expect(isGripState(s)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isGripState("")).toBe(false);
    expect(isGripState("QUEUED")).toBe(false);
    expect(isGripState("pending")).toBe(false);
    expect(isGripState("active")).toBe(false);
    expect(isGripState("unknown")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validGripTransition — full 8x8 = 64-cell sweep
// ──────────────────────────────────────────────────────────────────────────

describe("validGripTransition (full 8x8 sweep)", () => {
  it("returns true for every valid (from, to) pair", () => {
    for (const [from, to] of VALID_PAIRS) {
      expect(validGripTransition(from, to)).toBe(true);
    }
  });

  it("returns false for every invalid (from, to) pair (64 - 10 = 54)", () => {
    expect(INVALID_PAIRS).toHaveLength(54);
    for (const [from, to] of INVALID_PAIRS) {
      expect(validGripTransition(from, to)).toBe(false);
    }
  });

  it("rejects same-state transitions for every state", () => {
    for (const s of GRIP_STATES) {
      expect(validGripTransition(s, s)).toBe(false);
    }
  });

  it("rejects unknown source states", () => {
    expect(validGripTransition("nonsense", "queued")).toBe(false);
    expect(validGripTransition("", "assigned")).toBe(false);
  });

  it("rejects unknown target states", () => {
    expect(validGripTransition("queued", "nonsense")).toBe(false);
    expect(validGripTransition("running", "")).toBe(false);
  });

  it("rejects policy-relevant forbidden transitions", () => {
    // You cannot skip the queue — failed must go back through queued.
    expect(validGripTransition("failed", "running")).toBe(false);
    // queued cannot fail directly per LLD.
    expect(validGripTransition("queued", "failed")).toBe(false);
    // abandoned is a dead-end.
    expect(validGripTransition("abandoned", "queued")).toBe(false);
    expect(validGripTransition("abandoned", "archived")).toBe(false);
    // archived is a dead-end.
    expect(validGripTransition("archived", "queued")).toBe(false);
  });

  it("accepts policy-relevant allowed transitions", () => {
    expect(validGripTransition("failed", "queued")).toBe(true);
    expect(validGripTransition("failed", "abandoned")).toBe(true);
    expect(validGripTransition("running", "completed")).toBe(true);
    expect(validGripTransition("completed", "archived")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyGripTransition
// ──────────────────────────────────────────────────────────────────────────

describe("applyGripTransition", () => {
  it("applies every valid transition cleanly and returns a new object", () => {
    for (const [from, to] of VALID_PAIRS) {
      const grip: GripStateLike = { state: from, updated_at: 0 };
      const next = applyGripTransition(grip, to, { now: 12345 });
      expect(next.state).toBe(to);
      expect(next.updated_at).toBe(12345);
      // original is not mutated
      expect(grip.state).toBe(from);
      expect(grip.updated_at).toBe(0);
    }
  });

  it("does not mutate the input object (identity check)", () => {
    const grip: GripStateLike & { extra: string } = {
      state: "queued",
      updated_at: 100,
      extra: "preserved",
    };
    const next = applyGripTransition(grip, "assigned", { now: 200 });
    expect(next).not.toBe(grip);
    expect(next.extra).toBe("preserved");
    expect(grip.state).toBe("queued");
    expect(grip.updated_at).toBe(100);
  });

  it("throws InvalidTransitionError for every invalid pair", () => {
    for (const [from, to] of INVALID_PAIRS) {
      const grip: GripStateLike = { state: from, updated_at: 0 };
      expect(() => applyGripTransition(grip, to)).toThrow(InvalidTransitionError);
    }
  });

  it("throws for same-state transitions", () => {
    const grip: GripStateLike = { state: "running", updated_at: 0 };
    expect(() => applyGripTransition(grip, "running")).toThrow(InvalidTransitionError);
  });

  it("throws for unknown source state", () => {
    const grip: GripStateLike = { state: "bogus", updated_at: 0 };
    expect(() => applyGripTransition(grip, "assigned")).toThrow(InvalidTransitionError);
  });

  it("honors the `now` option for deterministic timestamps", () => {
    const grip: GripStateLike = { state: "queued", updated_at: 0 };
    const next = applyGripTransition(grip, "assigned", { now: 777 });
    expect(next.updated_at).toBe(777);
  });

  it("defaults updated_at to Date.now() when `now` is omitted", () => {
    const before = Date.now();
    const grip: GripStateLike = { state: "queued", updated_at: 0 };
    const next = applyGripTransition(grip, "assigned");
    const after = Date.now();
    expect(next.updated_at).toBeGreaterThanOrEqual(before);
    expect(next.updated_at).toBeLessThanOrEqual(after);
  });

  it("includes grip_id in the thrown error when provided", () => {
    const grip: GripStateLike = { state: "queued", updated_at: 0 };
    try {
      applyGripTransition(grip, "running", { grip_id: "g-42" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const ite = err as InvalidTransitionError;
      expect(ite.from).toBe("queued");
      expect(ite.to).toBe("running");
      expect(ite.grip_id).toBe("g-42");
      expect(ite.message).toContain("queued -> running");
      expect(ite.message).toContain("grip_id=g-42");
      expect(ite.name).toBe("InvalidTransitionError");
    }
  });

  it("omits grip_id suffix from the error message when not provided", () => {
    const grip: GripStateLike = { state: "queued", updated_at: 0 };
    try {
      applyGripTransition(grip, "running");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const ite = err as InvalidTransitionError;
      expect(ite.grip_id).toBeUndefined();
      expect(ite.message).not.toContain("grip_id=");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// getValidNextStates
// ──────────────────────────────────────────────────────────────────────────

describe("getValidNextStates", () => {
  it("matches GRIP_TRANSITIONS for every state", () => {
    for (const s of GRIP_STATES) {
      const expected = GRIP_TRANSITIONS.get(s);
      expect(expected).toBeDefined();
      const got = getValidNextStates(s);
      expect([...got].toSorted()).toEqual([...(expected ?? new Set())].toSorted());
    }
  });

  it("returns the empty set for both absorbing states", () => {
    expect(getValidNextStates("abandoned").size).toBe(0);
    expect(getValidNextStates("archived").size).toBe(0);
  });

  it("returns the three running outbound states", () => {
    expect(new Set(getValidNextStates("running"))).toEqual(
      new Set<GripState>(["blocked", "failed", "completed"]),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// isTerminalState
// ──────────────────────────────────────────────────────────────────────────

describe("isTerminalState", () => {
  it("returns true for `abandoned` and `archived`", () => {
    expect(isTerminalState("abandoned")).toBe(true);
    expect(isTerminalState("archived")).toBe(true);
  });

  it("returns false for the other 6 states", () => {
    const nonTerminal: GripState[] = [
      "queued",
      "assigned",
      "running",
      "blocked",
      "failed",
      "completed",
    ];
    for (const s of nonTerminal) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});
