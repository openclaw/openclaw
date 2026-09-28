// Covers heartbeat wake cooldown and flood-deferral decisions.
import { describe, expect, it } from "vitest";
import { recordRunStart, shouldDeferWake } from "./heartbeat-cooldown.js";

describe("shouldDeferWake", () => {
  type Input = Parameters<typeof shouldDeferWake>[0];
  function decide(input: Omit<Input, "intent"> & { intent?: Input["intent"] }) {
    return shouldDeferWake({ intent: "event", ...input });
  }

  // After-a-run baseline: agent has already run once, so the cooldown gate is
  // active for non-manual non-interval wakes.
  const afterRun = {
    nextDueMs: 100_000,
    now: 50_000,
    lastRunStartedAtMs: 49_000,
  };

  // Bootstrap baseline: agent has never run. nextDueMs is the first phase tick.
  const beforeFirstRun = {
    nextDueMs: 100_000,
    now: 50_000,
    lastRunStartedAtMs: undefined,
  };

  describe("manual wakes", () => {
    it("never defers manual wakes even within nextDueMs", () => {
      expect(decide({ ...afterRun, intent: "manual" })).toEqual({
        defer: false,
      });
    });

    it("never defers manual wakes even within min-spacing window", () => {
      expect(
        decide({
          intent: "manual",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_900,
        }),
      ).toEqual({ defer: false });
    });

    it("never defers manual wakes even during a flood", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "manual",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("immediate wake intent (wake-now contracts)", () => {
    it("does not defer immediate wakes within nextDueMs", () => {
      expect(decide({ ...afterRun, intent: "immediate" })).toEqual({
        defer: false,
      });
    });

    it("does not defer 'wake' within min-spacing window", () => {
      expect(
        decide({
          intent: "immediate",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_990,
        }),
      ).toEqual({ defer: false });
    });

    it("keeps the flood guard for immediate wakes", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "immediate",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
    });
  });

  describe("scheduled intent", () => {
    it("defers with 'not-due' when now < nextDueMs (interval cooldown)", () => {
      expect(decide({ ...afterRun, intent: "scheduled" })).toEqual({
        defer: true,
        reason: "not-due",
        retryAtMs: 100_000,
      });
    });

    it("defers interval wake before first run if nextDueMs is in future", () => {
      expect(decide({ ...beforeFirstRun, intent: "scheduled" })).toEqual({
        defer: true,
        reason: "not-due",
        retryAtMs: 100_000,
      });
    });

    it("does not defer interval wake when now >= nextDueMs", () => {
      expect(
        decide({
          intent: "scheduled",
          now: 100_001,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 70_000,
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("independently scheduled task intent", () => {
    it("ignores the base heartbeat due slot but keeps the minimum spacing guard", () => {
      expect(
        decide({
          ...afterRun,
          intent: "task",
          now: 80_000,
          lastRunStartedAtMs: 40_000,
        }),
      ).toEqual({ defer: false });
      expect(
        decide({
          ...afterRun,
          intent: "task",
          now: 80_000,
          lastRunStartedAtMs: 79_000,
        }),
      ).toEqual({ defer: true, reason: "min-spacing", retryAtMs: 109_000 });
    });

    it("keeps the flood guard", () => {
      const now = 1_000_000;
      expect(
        decide({
          intent: "task",
          now,
          nextDueMs: now + 60_000,
          lastRunStartedAtMs: now - 40_000,
          recentRunStarts: [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
    });
  });

  describe("event-driven wakes after a prior run (regression for #75436)", () => {
    it("defers event wakes when now < nextDueMs", () => {
      expect(decide(afterRun)).toEqual({
        defer: true,
        reason: "not-due",
        retryAtMs: 79_000,
      });
    });
  });

  describe("event-driven wakes before any prior run (bootstrap)", () => {
    it("does not defer the first event wake", () => {
      expect(decide(beforeFirstRun)).toEqual({
        defer: false,
      });
    });
  });

  it("admits retained event work after the spacing floor even before nextDueMs", () => {
    expect(
      decide({
        ...afterRun,
        now: 80_000,
        retainedWork: true,
      }),
    ).toEqual({ defer: false });
  });

  describe("min-spacing floor", () => {
    it("defers recent runs at the default spacing floor", () => {
      expect(
        decide({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 170_100,
        }),
      ).toEqual({ defer: true, reason: "min-spacing", retryAtMs: 200_100 });
      expect(
        decide({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 169_999,
        }),
      ).toEqual({ defer: false });
    });

    it("respects override of minSpacingMs", () => {
      expect(
        decide({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 199_500, // 500ms ago
          minSpacingMs: 1_000,
        }),
      ).toEqual({ defer: true, reason: "min-spacing", retryAtMs: 200_500 });
    });
  });

  describe("flood guard", () => {
    it("defers at the default threshold only while starts remain in the flood window", () => {
      const now = 1_000_000;
      expect(
        decide({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 30_001,
          recentRunStarts: [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
      expect(
        decide({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 30_001,
          recentRunStarts: [now - 65_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
        }),
      ).toEqual({ defer: false });
    });
  });
});

describe("recordRunStart", () => {
  it("bounds the default flood buffer", () => {
    const buffer: number[] = [];
    for (let value = 1; value <= 10; value += 1) {
      recordRunStart(buffer, value);
    }
    expect(buffer).toEqual([5, 6, 7, 8, 9, 10]);
  });
});
