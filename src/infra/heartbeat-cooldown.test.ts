import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOOD_THRESHOLD,
  DEFAULT_MIN_WAKE_SPACING_MS,
  classifyWakeReason,
  isImmediateWakeReason,
  recordRunStart,
  shouldDeferWake,
} from "./heartbeat-cooldown.js";

describe("isImmediateWakeReason", () => {
  it.each([
    { reason: "manual", expected: true },
    { reason: "wake", expected: true },
    { reason: "background-task", expected: true },
    { reason: "  manual  ", expected: true },
    { reason: "exec-event", expected: false },
    { reason: "interval", expected: false },
    { reason: "cron:job-x", expected: false },
    { reason: "hook:wake", expected: false },
    { reason: "acp:spawn:stream", expected: false },
    { reason: undefined, expected: false },
  ] as const)("classifies %j", ({ reason, expected }) => {
    expect(isImmediateWakeReason(reason)).toBe(expected);
  });
});

describe("classifyWakeReason", () => {
  it.each([
    { reason: "interval", expected: "interval" },
    { reason: "manual", expected: "manual" },
    { reason: "exec-event", expected: "exec-event" },
    { reason: "retry", expected: "retry" },
    { reason: "cron:job-x", expected: "cron" },
    { reason: "hook:wake", expected: "hook" },
    { reason: "acp:spawn:stream", expected: "wake" },
    { reason: "wake", expected: "wake" },
    { reason: "something-new", expected: "other" },
    { reason: undefined, expected: "other" },
  ] as const)("classifies %j", ({ reason, expected }) => {
    expect(classifyWakeReason(reason).kind).toBe(expected);
  });
});

describe("shouldDeferWake", () => {
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
      expect(shouldDeferWake({ ...afterRun, reason: "manual" })).toEqual({ defer: false });
    });

    it("never defers manual wakes even within min-spacing window", () => {
      expect(
        shouldDeferWake({
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
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("immediate wake reasons (system event --mode now, task completion)", () => {
    it("does not defer 'wake' even within nextDueMs (system event --mode now contract)", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "wake" })).toEqual({ defer: false });
    });

    it("does not defer 'background-task' even within nextDueMs (task completion contract)", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "background-task" })).toEqual({
        defer: false,
      });
    });

    it("does not defer 'wake' within min-spacing window", () => {
      expect(
        shouldDeferWake({
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_990,
          reason: "wake",
        }),
      ).toEqual({ defer: false });
    });

    // Critical distinction: 'wake' (bare) is the documented immediate path, but
    // 'acp:spawn:stream' classifies as kind 'wake' too via heartbeat-reason.ts
    // and is emitted on every spawn update — that's a feedback risk and must
    // remain gated.
    it("DOES defer 'acp:spawn:stream' within nextDueMs (still gated despite kind:wake)", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "acp:spawn:stream" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("flood guard still applies to 'wake' as a backstop against unexpected loops", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "wake",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });

    it("flood guard still applies to 'background-task' as a backstop", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "background-task",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });
  });

  describe("interval reason", () => {
    it("defers with 'not-due' when now < nextDueMs (interval cooldown)", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "interval" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers interval wake before first run if nextDueMs is in future", () => {
      expect(shouldDeferWake({ ...beforeFirstRun, reason: "interval" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("does not defer interval wake when now >= nextDueMs", () => {
      expect(
        shouldDeferWake({
          now: 100_001,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 70_000,
          reason: "interval",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("event-driven wakes after a prior run (regression for #75436)", () => {
    it("defers exec-event wakes when now < nextDueMs", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "exec-event" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers cron wakes when now < nextDueMs", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "cron:morning-brief" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers hook wakes when now < nextDueMs", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "hook:wake" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers acp spawn stream wakes when now < nextDueMs", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "acp:spawn:stream" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers unknown wake reasons when now < nextDueMs", () => {
      expect(shouldDeferWake({ ...afterRun, reason: "something-new" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });
  });

  describe("event-driven wakes before any prior run (bootstrap)", () => {
    it("does NOT defer the first exec-event wake (lets idle agent respond)", () => {
      expect(shouldDeferWake({ ...beforeFirstRun, reason: "exec-event" })).toEqual({
        defer: false,
      });
    });

    it("does NOT defer the first cron wake", () => {
      expect(shouldDeferWake({ ...beforeFirstRun, reason: "cron:job-x" })).toEqual({
        defer: false,
      });
    });

    it("does NOT defer the first hook wake", () => {
      expect(shouldDeferWake({ ...beforeFirstRun, reason: "hook:wake" })).toEqual({
        defer: false,
      });
    });
  });

  describe("min-spacing floor", () => {
    it("defers with 'min-spacing' when last run started within floor (post-cooldown race)", () => {
      // nextDueMs has just been crossed, but a run started ~10s ago — second
      // wake landed before the schedule advanced.
      expect(
        shouldDeferWake({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 200_000 - DEFAULT_MIN_WAKE_SPACING_MS + 100,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing" });
    });

    it("does not defer when last run is older than min-spacing", () => {
      expect(
        shouldDeferWake({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 200_000 - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });

    it("respects override of minSpacingMs", () => {
      expect(
        shouldDeferWake({
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 199_500, // 500ms ago
          minSpacingMs: 1_000,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing" });
    });

    it("does not gate manual wakes on min-spacing", () => {
      expect(
        shouldDeferWake({
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_999,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("flood guard", () => {
    it("defers with 'flood' when threshold runs land within window", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });

    it("does not flood-defer when recent runs are spread outside window", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 300_000,
        now - 240_000,
        now - 180_000,
        now - 120_000,
        now - 65_000, // just outside default 60s window
      ];
      expect(
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });

    it("does not flood-defer below threshold", () => {
      const now = 1_000_000;
      const recentRunStarts = [now - 30_000, now - 20_000, now - 10_000];
      expect(
        shouldDeferWake({
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });
  });
});

describe("recordRunStart", () => {
  it("trims buffer to threshold + 1 entries", () => {
    const buffer: number[] = [];
    for (let i = 1; i <= DEFAULT_FLOOD_THRESHOLD + 5; i++) {
      recordRunStart(buffer, i);
    }
    expect(buffer.length).toBe(DEFAULT_FLOOD_THRESHOLD + 1);
    expect(buffer[buffer.length - 1]).toBe(DEFAULT_FLOOD_THRESHOLD + 5);
  });

  it("preserves insertion order", () => {
    const buffer: number[] = [];
    recordRunStart(buffer, 100);
    recordRunStart(buffer, 200);
    recordRunStart(buffer, 300);
    expect(buffer).toEqual([100, 200, 300]);
  });
});
