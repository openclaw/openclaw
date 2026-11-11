// Control UI tests cover session goal behavior.
import { describe, expect, it } from "vitest";
import { createSessionGoalFixture } from "../../../src/gateway/session-goal.test-support.js";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalSummary,
  goalElapsedMs,
} from "../../../src/shared/session-goal-display.js";
import type { SessionGoal } from "../api/types.ts";

function buildGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return createSessionGoalFixture("goal-1", "Ship the web goal indicator", {
    updatedAt: 2,
    tokenStart: 100,
    tokensUsed: 12_400,
    tokenBudget: 50_000,
    ...overrides,
  });
}

describe("session goal formatting", () => {
  it("summarizes goal status and objective details", () => {
    const goal = buildGoal({ lastStatusNote: "Waiting for CI" });

    expect(formatGoalSummary(goal)).toBe("Pursuing goal (12k/50k)");
    expect(formatGoalDetail(goal)).toBe(
      "Pursuing goal (12k/50k): Ship the web goal indicator - Waiting for CI",
    );
  });

  it("uses terminal labels without a budget", () => {
    expect(formatGoalSummary(buildGoal({ status: "complete", tokenBudget: undefined }))).toBe(
      "Goal achieved (12k used)",
    );
  });

  it("tracks elapsed time live for active goals and freezes it on status stops", () => {
    const active = buildGoal({ createdAt: 1_000 });
    expect(goalElapsedMs(active, 16_000)).toBe(15_000);

    const paused = buildGoal({ status: "paused", createdAt: 1_000, pausedAt: 61_000 });
    expect(goalElapsedMs(paused, 999_000)).toBe(60_000);

    const complete = buildGoal({ status: "complete", createdAt: 1_000, completedAt: 121_000 });
    expect(goalElapsedMs(complete, 999_000)).toBe(120_000);

    const blockedWithoutTimestamp = buildGoal({
      status: "blocked",
      createdAt: 1_000,
      updatedAt: 31_000,
    });
    expect(goalElapsedMs(blockedWithoutTimestamp, 999_000)).toBe(30_000);
  });

  it("formats elapsed durations compactly", () => {
    expect(formatGoalElapsed(0)).toBe("0s");
    expect(formatGoalElapsed(15_000)).toBe("15s");
    expect(formatGoalElapsed(59_999)).toBe("59s");
    expect(formatGoalElapsed(60_000)).toBe("1m");
    expect(formatGoalElapsed(259_000)).toBe("4m");
    expect(formatGoalElapsed(7_500_000)).toBe("2h 5m");
    expect(formatGoalElapsed(93_900_000)).toBe("1d 2h 5m");
    expect(formatGoalElapsed(3_540_000)).toBe("59m");
    expect(formatGoalElapsed(3_600_000)).toBe("1h");
    expect(formatGoalElapsed(3_909_000)).toBe("1h 5m");
    expect(formatGoalElapsed(86_399_999)).toBe("23h 59m");
    expect(formatGoalElapsed(86_400_000)).toBe("1d 0h 0m");
    expect(formatGoalElapsed(176_400_000)).toBe("2d 1h 0m");
    expect(formatGoalElapsed(604_799_999)).toBe("6d 23h 59m");
    expect(formatGoalElapsed(604_800_000)).toBe("1wk 0d 0h 0m");
    expect(formatGoalElapsed(1_098_939_000)).toBe("1wk 5d 17h 15m");
    expect(formatGoalElapsed(1_209_600_000)).toBe("2wk 0d 0h 0m");
  });
});
