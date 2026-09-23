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
      expect(decide({ ...afterRun, intent: "manual", reason: "manual" })).toEqual({
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
          reason: "manual",
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
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("immediate wake intent (wake-now contracts)", () => {
    it.each<[name: string, reason: Input["reason"]]>([
      ["does not defer 'wake' even within nextDueMs (system event --mode now contract)", "wake"],
      [
        "does not defer 'background-task' even within nextDueMs (task completion contract)",
        "background-task",
      ],
      ["does not defer 'background-task-blocked' even within nextDueMs", "background-task-blocked"],
      ["does not defer explicit hook wake-now calls even within nextDueMs", "hook:wake"],
      ["does not defer explicit cron wake-now calls even within nextDueMs", "cron:morning-brief"],
    ])("%s", (_name, reason) => {
      expect(decide({ ...afterRun, intent: "immediate", reason })).toEqual({
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
          reason: "wake",
        }),
      ).toEqual({ defer: false });
    });

    it.each<[name: string, reason: Input["reason"]]>([
      ["flood guard still applies to 'wake' as a backstop against unexpected loops", "wake"],
      ["flood guard still applies to 'background-task' as a backstop", "background-task"],
      ["flood guard still applies to explicit wake-now bypass calls", "hook:wake"],
    ])("%s", (_name, reason) => {
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
          reason,
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
    });
  });

  describe("scheduled intent", () => {
    it("defers with 'not-due' when now < nextDueMs (interval cooldown)", () => {
      expect(decide({ ...afterRun, intent: "scheduled", reason: "interval" })).toEqual({
        defer: true,
        reason: "not-due",
        retryAtMs: 100_000,
      });
    });

    it("defers interval wake before first run if nextDueMs is in future", () => {
      expect(decide({ ...beforeFirstRun, intent: "scheduled", reason: "interval" })).toEqual({
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
          reason: "interval",
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
          reason: "heartbeat-task:inbox",
        }),
      ).toEqual({ defer: false });
      expect(
        decide({
          ...afterRun,
          intent: "task",
          now: 80_000,
          lastRunStartedAtMs: 79_000,
          reason: "heartbeat-task:inbox",
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
          reason: "heartbeat-task:inbox",
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
    });
  });

  describe("event-driven wakes after a prior run (regression for #75436)", () => {
    it.each<[name: string, source: Input["source"], reason: Input["reason"]]>([
      ["defers exec-event wakes when now < nextDueMs", "exec-event", "exec-event"],
      ["defers cron wakes when now < nextDueMs", "cron", "cron:morning-brief"],
      ["defers hook wakes when now < nextDueMs", "hook", "hook:wake"],
      ["defers acp spawn stream wakes when now < nextDueMs", "acp-spawn", "acp:spawn:stream"],
      ["defers unknown wake reasons when now < nextDueMs", "other", "something-new"],
    ])("%s", (_name, source, reason) => {
      expect(decide({ ...afterRun, source, reason })).toEqual({
        defer: true,
        reason: "not-due",
        retryAtMs: 79_000,
      });
    });
  });

  describe("event-driven wakes before any prior run (bootstrap)", () => {
    it.each<[name: string, source: Input["source"], reason: Input["reason"]]>([
      [
        "does NOT defer the first exec-event wake (lets idle agent respond)",
        "exec-event",
        "exec-event",
      ],
      ["does NOT defer the first cron wake", "cron", "cron:job-x"],
      ["does NOT defer the first hook wake", "hook", "hook:wake"],
    ])("%s", (_name, source, reason) => {
      expect(decide({ ...beforeFirstRun, source, reason })).toEqual({
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
        source: "exec-event",
        reason: "exec-event",
      }),
    ).toEqual({ defer: false });
  });

  describe("min-spacing floor", () => {
    it("defers recent runs at the default spacing floor", () => {
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 170_100,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing", retryAtMs: 200_100 });
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 169_999,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });

    it("respects override of minSpacingMs", () => {
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 199_500, // 500ms ago
          minSpacingMs: 1_000,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing", retryAtMs: 200_500 });
    });

    it("does not gate manual wakes on min-spacing", () => {
      expect(
        decide({
          intent: "manual",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_999,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("flood guard", () => {
    it("defers at the default threshold only while starts remain in the flood window", () => {
      const now = 1_000_000;
      expect(
        decide({
          source: "exec-event",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 30_001,
          recentRunStarts: [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "flood", retryAtMs: 1_010_001 });
      expect(
        decide({
          source: "exec-event",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 30_001,
          recentRunStarts: [now - 65_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000],
          reason: "exec-event",
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

  it("preserves insertion order", () => {
    const buffer: number[] = [];
    recordRunStart(buffer, 100);
    recordRunStart(buffer, 200);
    recordRunStart(buffer, 300);
    expect(buffer).toEqual([100, 200, 300]);
  });
});
