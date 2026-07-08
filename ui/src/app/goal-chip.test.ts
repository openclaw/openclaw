// Tests the Control-UI goal chip store: parsing `goal.updated` payloads into a
// single current-goal snapshot and the apply/clear transitions.
import { describe, expect, it } from "vitest";
import {
  applyGoalUpdated,
  clearGoalChip,
  parseGoalUpdated,
  type GoalChipState,
} from "./goal-chip.ts";
import { goalActionCommand } from "./overlays.ts";

const ACTIVE = {
  sessionKey: "agent:main:web:main",
  status: "active",
  objective: "finish the migration",
  tokensUsed: 120,
  tokenBudget: 5000,
  source: "host",
};

function makeState(): GoalChipState {
  return { client: null, goal: null, busy: false, error: null };
}

describe("goal chip store", () => {
  it("parses an active goal.updated payload into a chip entry", () => {
    expect(parseGoalUpdated(ACTIVE)).toEqual({
      sessionKey: "agent:main:web:main",
      status: "active",
      objective: "finish the migration",
      tokensUsed: 120,
      tokenBudget: 5000,
    });
  });

  it("treats a cleared (status:null) or completed goal as no chip", () => {
    expect(
      parseGoalUpdated({ sessionKey: "s1", status: null, objective: null, source: "host" }),
    ).toBeNull();
    expect(parseGoalUpdated({ ...ACTIVE, status: "complete" })).toBeNull();
    // Missing session key or objective is not a chip.
    expect(parseGoalUpdated({ ...ACTIVE, sessionKey: "" })).toBeNull();
    expect(parseGoalUpdated({ ...ACTIVE, objective: "" })).toBeNull();
  });

  it("normalizes missing usage counts to null", () => {
    const entry = parseGoalUpdated({ ...ACTIVE, tokensUsed: undefined, tokenBudget: undefined });
    expect(entry?.tokensUsed).toBeNull();
    expect(entry?.tokenBudget).toBeNull();
  });

  it("applies an active goal.updated event as the current chip", () => {
    const state = makeState();
    applyGoalUpdated(state, ACTIVE);
    expect(state.goal?.objective).toBe("finish the migration");
    expect(state.goal?.status).toBe("active");
  });

  it("removes the chip when the current session's goal is cleared", () => {
    const state = makeState();
    applyGoalUpdated(state, ACTIVE);
    applyGoalUpdated(state, {
      sessionKey: ACTIVE.sessionKey,
      status: null,
      objective: null,
      source: "host",
    });
    expect(state.goal).toBeNull();
  });

  it("keeps the chip when a clear event targets a different session", () => {
    const state = makeState();
    applyGoalUpdated(state, ACTIVE);
    applyGoalUpdated(state, {
      sessionKey: "agent:main:other",
      status: null,
      objective: null,
      source: "host",
    });
    expect(state.goal?.sessionKey).toBe(ACTIVE.sessionKey);
  });

  it("reflects a driver auto-pause by updating the status in place", () => {
    const state = makeState();
    applyGoalUpdated(state, ACTIVE);
    applyGoalUpdated(state, { ...ACTIVE, status: "paused", source: "driver" });
    expect(state.goal?.status).toBe("paused");
  });

  it("clearGoalChip resets the store", () => {
    const state = makeState();
    applyGoalUpdated(state, ACTIVE);
    state.busy = true;
    state.error = "x";
    clearGoalChip(state);
    expect(state.goal).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });
});

describe("goalActionCommand", () => {
  it("maps chip actions to the existing /goal host verbs", () => {
    expect(goalActionCommand("pause")).toBe("/goal pause");
    expect(goalActionCommand("resume")).toBe("/goal resume");
    expect(goalActionCommand("stop")).toBe("/goal stop");
    expect(goalActionCommand("edit", { objective: "ship it" })).toBe("/goal edit ship it");
    expect(goalActionCommand("edit", { objective: "ship it", tokenBudget: 8000 })).toBe(
      "/goal edit ship it --budget 8000",
    );
    // A non-positive budget is dropped.
    expect(goalActionCommand("edit", { objective: "ship it", tokenBudget: 0 })).toBe(
      "/goal edit ship it",
    );
  });
});
