import { describe, expect, it } from "vitest";
import {
  countTitleRefinementMessage,
  resolveSessionTitleRefineConfig,
  type SessionTitleRefinementState,
} from "./session-title-refinement-state.js";

const SID = "sess-1";

describe("resolveSessionTitleRefineConfig", () => {
  it("is opt-in: disabled by default", () => {
    expect(resolveSessionTitleRefineConfig({}).enabled).toBe(false);
    expect(resolveSessionTitleRefineConfig({ cfgSession: {} }).enabled).toBe(false);
  });

  it("enables only on explicit refine=true", () => {
    expect(
      resolveSessionTitleRefineConfig({ cfgSession: { autoTitle: { refine: true } } }).enabled,
    ).toBe(true);
    expect(
      resolveSessionTitleRefineConfig({ cfgSession: { autoTitle: { refine: false } } }).enabled,
    ).toBe(false);
  });

  it("uses default threshold and clamps invalid values out of 1..100", () => {
    const cfg = (after: number | undefined) =>
      resolveSessionTitleRefineConfig({
        cfgSession: { autoTitle: { refine: true, refineAfterMessages: after } },
      });
    expect(cfg(undefined).afterMessages).toBe(6);
    expect(cfg(0).afterMessages).toBe(6);
    expect(cfg(101).afterMessages).toBe(6);
    expect(cfg(3.5 as unknown as number).afterMessages).toBe(6);
    expect(cfg(10).afterMessages).toBe(10);
  });
});

describe("countTitleRefinementMessage", () => {
  const NAME = "Generated Title";

  it("starts at 1 without prior state", () => {
    expect(countTitleRefinementMessage(undefined, SID, NAME)).toEqual({
      taskMessagesSinceTitle: 1,
      refinementDone: false,
      sessionId: SID,
      generatedName: NAME,
    });
  });

  it("increments prior state and tracks the owned generated name", () => {
    const prior: SessionTitleRefinementState = {
      taskMessagesSinceTitle: 2,
      refinementDone: false,
      sessionId: SID,
      generatedName: NAME,
    };
    const next = countTitleRefinementMessage(prior, SID, NAME);
    expect(next.taskMessagesSinceTitle).toBe(3);
    expect(next.generatedName).toBe(NAME);
  });

  it("resets on sessionId change (new session after /reset)", () => {
    const prior: SessionTitleRefinementState = {
      taskMessagesSinceTitle: 5,
      refinementDone: false,
      sessionId: "old-session",
      generatedName: NAME,
    };
    expect(countTitleRefinementMessage(prior, SID, NAME)).toEqual({
      taskMessagesSinceTitle: 1,
      refinementDone: false,
      sessionId: SID,
      generatedName: NAME,
    });
  });

  it("retains a bounded rolling excerpt of later tasks", () => {
    let state: SessionTitleRefinementState | undefined;
    for (let index = 1; index <= 10; index++) {
      state = countTitleRefinementMessage(state, SID, NAME, `task ${index} ${"x".repeat(600)}`);
    }
    expect(state?.recentMessages).toHaveLength(8);
    expect(state?.recentMessages?.[0]).toContain("task 3");
    expect(state?.recentMessages?.at(-1)).toContain("task 10");
    expect(state?.recentMessages?.every((message) => message.length <= 500)).toBe(true);
  });
});
