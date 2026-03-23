import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AggregateComputer,
  computeFromRecords,
  hourToPeriod,
  periodToStartHour,
} from "./aggregates.js";
import { appendAction, appendOutcome, readAggregates } from "./persistence.js";
import type { ActionRecord, OutcomeRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAction(overrides?: Partial<ActionRecord>): ActionRecord {
  return {
    id: "act-001",
    timestamp: "2026-03-22T10:00:00.000Z",
    agentId: "agent-1",
    sessionKey: "session-abc",
    actionType: "agent_reply",
    channelId: "telegram",
    policyMode: "passive",
    ...overrides,
  };
}

function makeOutcome(overrides?: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    id: "out-001",
    timestamp: "2026-03-22T10:01:00.000Z",
    actionId: "act-001",
    agentId: "agent-1",
    outcomeType: "delivery_success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-aggregates-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Time-of-day helpers
// ---------------------------------------------------------------------------

describe("hourToPeriod", () => {
  it("classifies morning hours (6-11)", () => {
    expect(hourToPeriod(6)).toBe("morning");
    expect(hourToPeriod(11)).toBe("morning");
  });

  it("classifies afternoon hours (12-17)", () => {
    expect(hourToPeriod(12)).toBe("afternoon");
    expect(hourToPeriod(17)).toBe("afternoon");
  });

  it("classifies evening hours (18-21)", () => {
    expect(hourToPeriod(18)).toBe("evening");
    expect(hourToPeriod(21)).toBe("evening");
  });

  it("classifies night hours (22-5)", () => {
    expect(hourToPeriod(22)).toBe("night");
    expect(hourToPeriod(0)).toBe("night");
    expect(hourToPeriod(5)).toBe("night");
  });
});

describe("periodToStartHour", () => {
  it("maps periods to their start hours", () => {
    expect(periodToStartHour("morning")).toBe(6);
    expect(periodToStartHour("afternoon")).toBe(12);
    expect(periodToStartHour("evening")).toBe(18);
    expect(periodToStartHour("night")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeFromRecords (pure function)
// ---------------------------------------------------------------------------

describe("computeFromRecords", () => {
  it("returns empty stats for empty inputs", () => {
    const stats = computeFromRecords([], []);
    expect(stats.totalActions).toBe(0);
    expect(stats.totalOutcomes).toBe(0);
    expect(stats.byActionType).toEqual({});
    expect(stats.byHourOfDay).toEqual({});
    expect(stats.byChannel).toEqual({});
    expect(stats.byConsecutiveIgnores).toEqual({});
  });

  it("counts actions by type", () => {
    const actions = [
      makeAction({ id: "a1", actionType: "agent_reply" }),
      makeAction({ id: "a2", actionType: "agent_reply" }),
      makeAction({ id: "a3", actionType: "tool_call" }),
    ];

    const stats = computeFromRecords(actions, []);
    expect(stats.totalActions).toBe(3);
    expect(stats.byActionType.agent_reply?.count).toBe(2);
    expect(stats.byActionType.tool_call?.count).toBe(1);
  });

  it("computes reply rates from outcomes", () => {
    const actions = [makeAction({ id: "a1" }), makeAction({ id: "a2" }), makeAction({ id: "a3" })];
    const outcomes = [
      makeOutcome({ id: "o1", actionId: "a1", outcomeType: "user_replied" }),
      makeOutcome({ id: "o2", actionId: "a2", outcomeType: "user_silent" }),
    ];

    const stats = computeFromRecords(actions, outcomes);
    // 1 reply out of 3 actions
    expect(stats.byActionType.agent_reply?.replyRate).toBeCloseTo(1 / 3);
  });

  it("tracks per-hour-of-day stats", () => {
    const actions = [
      makeAction({ id: "a1", timestamp: "2026-03-22T10:00:00.000Z" }), // hour 10
      makeAction({ id: "a2", timestamp: "2026-03-22T15:00:00.000Z" }), // hour 15
      makeAction({ id: "a3", timestamp: "2026-03-22T10:30:00.000Z" }), // hour 10
    ];

    const stats = computeFromRecords(actions, []);
    expect(stats.byHourOfDay[10]?.count).toBe(2);
    expect(stats.byHourOfDay[15]?.count).toBe(1);
  });

  it("tracks per-channel stats", () => {
    const actions = [
      makeAction({ id: "a1", channelId: "telegram" }),
      makeAction({ id: "a2", channelId: "discord" }),
      makeAction({ id: "a3", channelId: "telegram" }),
    ];
    const outcomes = [makeOutcome({ id: "o1", actionId: "a1", outcomeType: "user_replied" })];

    const stats = computeFromRecords(actions, outcomes);
    expect(stats.byChannel.telegram?.count).toBe(2);
    expect(stats.byChannel.telegram?.replyRate).toBe(0.5);
    expect(stats.byChannel.discord?.count).toBe(1);
    expect(stats.byChannel.discord?.replyRate).toBe(0);
  });

  it("tracks suppression rate", () => {
    const actions = [
      makeAction({ id: "a1", actionType: "suppressed" }),
      makeAction({ id: "a2", actionType: "suppressed" }),
      makeAction({ id: "a3", actionType: "agent_reply" }),
    ];

    const stats = computeFromRecords(actions, []);
    expect(stats.byActionType.suppressed?.suppressionRate).toBe(1);
    expect(stats.byActionType.agent_reply?.suppressionRate).toBe(0);
  });

  it("computes fatigue correlation (consecutive ignores)", () => {
    // Session with 3 actions, first two ignored, third gets reply
    const actions = [
      makeAction({ id: "a1", sessionKey: "s1" }),
      makeAction({ id: "a2", sessionKey: "s1" }),
      makeAction({ id: "a3", sessionKey: "s1" }),
    ];
    const outcomes = [
      // Only a3 gets a reply
      makeOutcome({ id: "o1", actionId: "a3", outcomeType: "user_replied" }),
    ];

    const stats = computeFromRecords(actions, outcomes);
    // a1 at 0 consecutive ignores, no reply
    // a2 at 1 consecutive ignore, no reply
    // a3 at 2 consecutive ignores, got reply
    expect(stats.byConsecutiveIgnores[0]?.count).toBe(1);
    expect(stats.byConsecutiveIgnores[0]?.replyRate).toBe(0);
    expect(stats.byConsecutiveIgnores[1]?.count).toBe(1);
    expect(stats.byConsecutiveIgnores[1]?.replyRate).toBe(0);
    expect(stats.byConsecutiveIgnores[2]?.count).toBe(1);
    expect(stats.byConsecutiveIgnores[2]?.replyRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AggregateComputer class
// ---------------------------------------------------------------------------

describe("AggregateComputer", () => {
  describe("recomputeAggregates", () => {
    it("computes from persisted logs and writes to disk", async () => {
      const a1 = makeAction({ id: "a1" });
      const a2 = makeAction({ id: "a2", actionType: "tool_call" });
      await appendAction(a1, { home: tmpDir });
      await appendAction(a2, { home: tmpDir });

      const o1 = makeOutcome({ id: "o1", actionId: "a1", outcomeType: "user_replied" });
      await appendOutcome(o1, { home: tmpDir });

      const computer = new AggregateComputer();
      const results = await computer.recomputeAggregates(tmpDir);

      expect(results).toHaveLength(1);
      expect(results[0].totalActions).toBe(2);
      expect(results[0].totalOutcomes).toBe(1);

      // Verify written to disk
      const stored = await readAggregates({ home: tmpDir });
      expect(stored?.totalActions).toBe(2);
    });

    it("handles empty logs gracefully", async () => {
      const computer = new AggregateComputer();
      const results = await computer.recomputeAggregates(tmpDir);

      expect(results).toHaveLength(1);
      expect(results[0].totalActions).toBe(0);
      expect(results[0].totalOutcomes).toBe(0);
    });

    it("supports per-agent recomputation", async () => {
      const a1 = makeAction({ id: "a1", agentId: "agent-x" });
      await appendAction(a1, { agentId: "agent-x", home: tmpDir });

      const computer = new AggregateComputer();
      const results = await computer.recomputeAggregates(tmpDir, { agentId: "agent-x" });

      expect(results[0].totalActions).toBe(1);

      // Verify written to agent-scoped path
      const stored = await readAggregates({ agentId: "agent-x", home: tmpDir });
      expect(stored?.totalActions).toBe(1);
    });
  });

  describe("updateAggregatesIncremental", () => {
    it("increments outcome count without recounting actions", () => {
      const computer = new AggregateComputer();
      const action = makeAction({ id: "a1" });
      const outcome = makeOutcome({
        id: "o1",
        actionId: "a1",
        outcomeType: "user_replied",
      });

      // Seed the action type stats (as recomputeAggregates would)
      const stats = computeFromRecords([action], []);
      // Manually set cached aggregates via a full recompute mock
      (computer as unknown as { aggregates: typeof stats }).aggregates = stats;

      computer.updateAggregatesIncremental(action, outcome);

      return computer.getAggregates().then((results) => {
        // Action count should NOT increase (already counted)
        expect(results[0].totalActions).toBe(1);
        // Outcome count should increase
        expect(results[0].totalOutcomes).toBe(1);
        expect(results[0].byActionType.agent_reply?.outcomeCount).toBe(1);
        expect(results[0].byActionType.agent_reply?.replyRate).toBe(1);
      });
    });

    it("correctly updates reply rate over multiple outcomes", () => {
      const computer = new AggregateComputer();
      const a1 = makeAction({ id: "a1" });
      const a2 = makeAction({ id: "a2" });

      // Seed with action stats
      const stats = computeFromRecords([a1, a2], []);
      (computer as unknown as { aggregates: typeof stats }).aggregates = stats;

      const replied = makeOutcome({
        id: "o1",
        actionId: "a1",
        outcomeType: "user_replied",
      });
      const silent = makeOutcome({
        id: "o2",
        actionId: "a2",
        outcomeType: "user_silent",
      });

      computer.updateAggregatesIncremental(a1, replied);
      computer.updateAggregatesIncremental(a2, silent);

      return computer.getAggregates().then((results) => {
        expect(results[0].totalActions).toBe(2);
        expect(results[0].totalOutcomes).toBe(2);
        expect(results[0].byActionType.agent_reply?.replyRate).toBeCloseTo(0.5);
      });
    });
  });

  describe("getAggregates", () => {
    it("returns all aggregates when no filter specified", async () => {
      const computer = new AggregateComputer();
      const actions = [
        makeAction({ id: "a1" }),
        makeAction({ id: "a2", actionType: "tool_call" }),
      ];
      const stats = computeFromRecords(actions, []);
      (computer as unknown as { aggregates: typeof stats }).aggregates = stats;

      const results = await computer.getAggregates();
      expect(results).toHaveLength(1);
      expect(results[0].byActionType.agent_reply).toBeDefined();
      expect(results[0].byActionType.tool_call).toBeDefined();
    });

    it("filters by action type when specified", async () => {
      const computer = new AggregateComputer();
      const actions = [
        makeAction({ id: "a1" }),
        makeAction({ id: "a2", actionType: "tool_call" }),
      ];
      const stats = computeFromRecords(actions, []);
      (computer as unknown as { aggregates: typeof stats }).aggregates = stats;

      const results = await computer.getAggregates("agent_reply");
      expect(results).toHaveLength(1);
      expect(results[0].byActionType.agent_reply).toBeDefined();
      expect(results[0].byActionType.tool_call).toBeUndefined();
    });

    it("returns empty aggregate when filtering by nonexistent type", async () => {
      const computer = new AggregateComputer();
      const results = await computer.getAggregates("cron_run");
      expect(results).toHaveLength(1);
      expect(results[0].byActionType.cron_run).toBeUndefined();
    });
  });
});
