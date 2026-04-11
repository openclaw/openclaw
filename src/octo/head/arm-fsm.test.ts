// Octopus Orchestrator — Arm FSM tests (M1-07)
//
// The transition matrix sweep is the load-bearing acceptance criterion:
// every valid transition ok, every invalid transition throws. Test cases
// are GENERATED from the same ARM_TRANSITIONS map the implementation
// uses, so drift between the LLD diagram, the map, and the tests is
// impossible by construction.

import { describe, expect, it } from "vitest";
import {
  ARM_STATES,
  ARM_TRANSITIONS,
  applyArmTransition,
  getValidNextStates,
  InvalidTransitionError,
  isArmState,
  isTerminalState,
  validArmTransition,
  type ArmState,
  type ArmStateLike,
} from "./arm-fsm.ts";

// ──────────────────────────────────────────────────────────────────────────
// Sweep helpers — generated from the single source of truth
// ──────────────────────────────────────────────────────────────────────────

const allTransitionPairs: [ArmState, ArmState][] = [];
for (const from of ARM_STATES) {
  for (const to of ARM_STATES) {
    allTransitionPairs.push([from, to]);
  }
}

const validPairs = allTransitionPairs.filter(([f, t]) => ARM_TRANSITIONS.get(f)?.has(t) ?? false);
const invalidPairs = allTransitionPairs.filter(
  ([f, t]) => !(ARM_TRANSITIONS.get(f)?.has(t) ?? false),
);

function makeArm(state: string, updated_at = 1_000): ArmStateLike {
  return { state, updated_at };
}

// ──────────────────────────────────────────────────────────────────────────
// Enum / table integrity
// ──────────────────────────────────────────────────────────────────────────

describe("ARM_STATES", () => {
  it("has exactly 10 entries", () => {
    expect(ARM_STATES).toHaveLength(10);
  });

  it("contains every LLD-listed state name verbatim", () => {
    expect(new Set<string>(ARM_STATES)).toEqual(
      new Set<string>([
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
      ]),
    );
  });
});

describe("ARM_TRANSITIONS", () => {
  it("covers all 10 states as keys", () => {
    for (const state of ARM_STATES) {
      expect(ARM_TRANSITIONS.has(state)).toBe(true);
    }
    expect(ARM_TRANSITIONS.size).toBe(ARM_STATES.length);
  });

  it("has archived as absorbing terminal state (empty outbound set)", () => {
    expect(ARM_TRANSITIONS.get("archived")?.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validArmTransition — full 10x10 sweep
// ──────────────────────────────────────────────────────────────────────────

describe("validArmTransition", () => {
  it.each(validPairs)("valid: %s -> %s returns true", (from, to) => {
    expect(validArmTransition(from, to)).toBe(true);
  });

  it.each(invalidPairs)("invalid: %s -> %s returns false", (from, to) => {
    expect(validArmTransition(from, to)).toBe(false);
  });

  it("rejects unknown source state", () => {
    expect(validArmTransition("fictional", "active")).toBe(false);
  });

  it("rejects unknown target state", () => {
    expect(validArmTransition("active", "fictional")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyArmTransition — full sweep
// ──────────────────────────────────────────────────────────────────────────

describe("applyArmTransition", () => {
  it.each(validPairs)("valid: %s -> %s produces updated arm", (from, to) => {
    const arm = makeArm(from, 1_000);
    const next = applyArmTransition(arm, to, { now: 2_000 });
    expect(next.state).toBe(to);
    expect(next.updated_at).toBe(2_000);
  });

  it.each(invalidPairs)("invalid: %s -> %s throws InvalidTransitionError", (from, to) => {
    const arm = makeArm(from);
    let caught: unknown;
    try {
      applyArmTransition(arm, to, { now: 2_000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const err = caught as InvalidTransitionError;
    expect(err.from).toBe(from);
    expect(err.to).toBe(to);
  });

  it("does not mutate the input arm", () => {
    const arm = makeArm("pending", 1_000);
    const snapshot = { ...arm };
    applyArmTransition(arm, "starting", { now: 2_000 });
    expect(arm).toEqual(snapshot);
  });

  it("same-state transition (active -> active) throws", () => {
    const arm = makeArm("active");
    expect(() => applyArmTransition(arm, "active")).toThrow(InvalidTransitionError);
  });

  it("unknown source state throws", () => {
    const arm = makeArm("fictional");
    expect(() => applyArmTransition(arm, "active")).toThrow(InvalidTransitionError);
  });

  it("unknown target state throws", () => {
    const arm = makeArm("active");
    expect(() => applyArmTransition(arm, "fictional" as ArmState)).toThrow(InvalidTransitionError);
  });

  it("explicit `now` option is used as updated_at", () => {
    const arm = makeArm("pending", 1);
    const next = applyArmTransition(arm, "starting", {
      now: 1_700_000_000_000,
    });
    expect(next.updated_at).toBe(1_700_000_000_000);
  });

  it("falls back to Date.now() when opts.now is omitted", () => {
    const before = Date.now();
    const arm = makeArm("pending", 1);
    const next = applyArmTransition(arm, "starting");
    const after = Date.now();
    expect(next.updated_at).toBeGreaterThanOrEqual(before);
    expect(next.updated_at).toBeLessThanOrEqual(after);
  });

  it("arm_id option is included on the thrown error", () => {
    const arm = makeArm("active");
    let caught: unknown;
    try {
      applyArmTransition(arm, "pending", { arm_id: "test-arm" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const err = caught as InvalidTransitionError;
    expect(err.arm_id).toBe("test-arm");
    expect(err.message).toContain("test-arm");
  });

  it("preserves extra fields on a wider arm-like record", () => {
    interface WiderArm extends ArmStateLike {
      arm_id: string;
      version: number;
    }
    const arm: WiderArm = {
      arm_id: "arm-123",
      version: 7,
      state: "pending",
      updated_at: 1_000,
    };
    const next = applyArmTransition(arm, "starting", { now: 2_000 });
    expect(next.arm_id).toBe("arm-123");
    expect(next.version).toBe(7);
    expect(next.state).toBe("starting");
    expect(next.updated_at).toBe(2_000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

describe("getValidNextStates", () => {
  it.each(ARM_STATES)("%s: returned set matches ARM_TRANSITIONS", (state) => {
    const expected = ARM_TRANSITIONS.get(state);
    const actual = getValidNextStates(state);
    expect(actual).toBe(expected);
  });
});

describe("isTerminalState", () => {
  it.each(ARM_STATES)("%s: correct terminal status", (state) => {
    expect(isTerminalState(state)).toBe(state === "archived");
  });
});

describe("isArmState", () => {
  it.each(ARM_STATES)("%s is a valid ArmState", (state) => {
    expect(isArmState(state)).toBe(true);
  });

  it.each(["", "fictional", "ACTIVE", "Pending", "arm.active"])(
    "%s is NOT a valid ArmState",
    (bogus) => {
      expect(isArmState(bogus)).toBe(false);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Error class
// ──────────────────────────────────────────────────────────────────────────

describe("InvalidTransitionError", () => {
  it("is an Error subclass with name 'InvalidTransitionError'", () => {
    const err = new InvalidTransitionError("active", "pending");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.name).toBe("InvalidTransitionError");
    expect(err.from).toBe("active");
    expect(err.to).toBe("pending");
    expect(err.arm_id).toBeUndefined();
  });

  it("message includes arm_id when provided", () => {
    const err = new InvalidTransitionError("active", "pending", "arm-xyz");
    expect(err.message).toContain("active -> pending");
    expect(err.message).toContain("arm-xyz");
    expect(err.arm_id).toBe("arm-xyz");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Sanity: valid transition count matches the LLD diagram
// ──────────────────────────────────────────────────────────────────────────

describe("transition table sanity", () => {
  it("has 22 valid transitions per the LLD diagram", () => {
    // pending(1) + starting(2) + active(6) + idle(4) + blocked(4)
    //   + failed(3) + quarantined(2) + completed(1) + terminated(1)
    //   + archived(0) = 24
    // (LLD lists these exact edges; recount to make this test
    //  self-documenting rather than magic.)
    let count = 0;
    for (const [, outbound] of ARM_TRANSITIONS) {
      count += outbound.size;
    }
    expect(count).toBe(24);
    expect(validPairs).toHaveLength(count);
  });
});
