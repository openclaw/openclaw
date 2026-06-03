import { describe, expect, it } from "vitest";
import type { CronConfig } from "../../config/types.cron.js";
import type { CronJobCreate, CronSchedule } from "../types.js";
import { assertScheduleMeetsMinInterval, createJob } from "./jobs.js";
import type { CronServiceState } from "./state.js";

const NOW = Date.parse("2026-02-28T12:00:00.000Z");

function createMockState(opts?: { cronConfig?: CronConfig; defaultAgentId?: string }) {
  return {
    deps: {
      nowMs: () => NOW,
      cronConfig: opts?.cronConfig,
      defaultAgentId: opts?.defaultAgentId ?? "main",
    },
  } as unknown as CronServiceState;
}

describe("assertScheduleMeetsMinInterval", () => {
  it("is a no-op when the floor is 0 or negative", () => {
    const everySecond: CronSchedule = { kind: "every", everyMs: 1000 };
    expect(() => assertScheduleMeetsMinInterval(everySecond, 0, NOW)).not.toThrow();
    expect(() => assertScheduleMeetsMinInterval(everySecond, -1, NOW)).not.toThrow();
  });

  it("exempts one-shot at schedules", () => {
    const at: CronSchedule = { kind: "at", at: "2026-03-01T00:00:00.000Z" };
    expect(() => assertScheduleMeetsMinInterval(at, 60_000, NOW)).not.toThrow();
  });

  describe("every schedules", () => {
    it("rejects intervals below the floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "every", everyMs: 30_000 }, 300_000, NOW),
      ).toThrow(/below the minimum interval/);
    });

    it("allows an interval equal to the floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "every", everyMs: 300_000 }, 300_000, NOW),
      ).not.toThrow();
    });

    it("allows an interval above the floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "every", everyMs: 600_000 }, 300_000, NOW),
      ).not.toThrow();
    });
  });

  describe("cron expression schedules", () => {
    it("rejects per-second expressions under a one-minute floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "cron", expr: "* * * * * *" }, 60_000, NOW),
      ).toThrow(/below the minimum interval/);
    });

    it("rejects per-minute expressions under a five-minute floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "cron", expr: "*/1 * * * *" }, 300_000, NOW),
      ).toThrow(/below the minimum interval/);
    });

    it("allows a per-minute expression at a one-minute floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "cron", expr: "*/1 * * * *" }, 60_000, NOW),
      ).not.toThrow();
    });

    it("allows a daily expression under an hourly floor", () => {
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "cron", expr: "0 9 * * *" }, 3_600_000, NOW),
      ).not.toThrow();
    });

    it("catches the tightest gap of an irregular expression", () => {
      // Fires at :00 and :01 each hour: a 1-minute gap then a 59-minute gap.
      expect(() =>
        assertScheduleMeetsMinInterval({ kind: "cron", expr: "0,1 * * * *" }, 300_000, NOW),
      ).toThrow(/below the minimum interval/);
    });
  });
});

describe("createJob enforces cron.minInterval", () => {
  const isolatedEvery = (everyMs: number): CronJobCreate => ({
    name: "fast-job",
    enabled: true,
    schedule: { kind: "every", everyMs },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "go" },
  });

  it("rejects an every job below the configured floor", () => {
    const state = createMockState({ cronConfig: { minInterval: "5m" } });
    expect(() => createJob(state, isolatedEvery(30_000))).toThrow(/below the minimum interval/);
  });

  it("allows an every job at or above the floor", () => {
    const state = createMockState({ cronConfig: { minInterval: "5m" } });
    expect(() => createJob(state, isolatedEvery(300_000))).not.toThrow();
  });

  it("rejects a too-frequent cron expression", () => {
    const state = createMockState({ cronConfig: { minInterval: "5m" } });
    expect(() =>
      createJob(state, {
        name: "minutely",
        enabled: true,
        schedule: { kind: "cron", expr: "*/1 * * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
      }),
    ).toThrow(/below the minimum interval/);
  });

  it("imposes no floor when cron.minInterval is unset", () => {
    const state = createMockState();
    expect(() => createJob(state, isolatedEvery(1000))).not.toThrow();
  });
});
