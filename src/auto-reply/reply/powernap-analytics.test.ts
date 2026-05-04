import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_STATE_DIR = "/tmp/openclaw-test-analytics";

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => TEST_STATE_DIR,
}));

const { getPowernapStats, recordPowernapEvent } = await import("./powernap-analytics.js");

describe("powernap-analytics", () => {
  beforeEach(() => {
    mkdirSync(path.join(TEST_STATE_DIR, "powernap"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  });

  it("records an event to history.jsonl", () => {
    recordPowernapEvent({
      ts: Date.now(),
      intent: "glitch",
      sessionsReset: 5,
      subagentsInterrupted: 1,
      durationMs: 150,
      trigger: "manual",
      mode: "all",
    });

    const historyPath = path.join(TEST_STATE_DIR, "powernap", "history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
    const content = readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.intent).toBe("glitch");
    expect(parsed.sessionsReset).toBe(5);
  });

  it("appends multiple events", () => {
    recordPowernapEvent({
      ts: Date.now() - 1000,
      intent: "deploy",
      sessionsReset: 3,
      subagentsInterrupted: 0,
      durationMs: 100,
      trigger: "manual",
    });
    recordPowernapEvent({
      ts: Date.now(),
      intent: "glitch",
      sessionsReset: 10,
      subagentsInterrupted: 2,
      durationMs: 200,
      trigger: "manual",
    });

    const historyPath = path.join(TEST_STATE_DIR, "powernap", "history.jsonl");
    const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns stats summary for recorded events", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      recordPowernapEvent({
        ts: now - i * 1000,
        intent: i < 3 ? "glitch" : "deploy",
        sessionsReset: 10,
        subagentsInterrupted: 0,
        durationMs: 100 + i * 10,
        trigger: "manual",
        mode: "all",
      });
    }

    const stats = getPowernapStats(7);
    expect(stats).toContain("Total: 5 powernaps");
    expect(stats).toContain("Sessions reset: 50");
    expect(stats).toContain("Top intent: glitch");
    expect(stats).toContain("Modes: all:5");
  });

  it("returns 'no history' when no file exists", () => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    const stats = getPowernapStats();
    expect(stats).toContain("No powernap history");
  });

  it("filters events outside the window", () => {
    const now = Date.now();
    recordPowernapEvent({
      ts: now - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      intent: "glitch",
      sessionsReset: 5,
      subagentsInterrupted: 0,
      durationMs: 100,
      trigger: "manual",
    });

    const stats = getPowernapStats(7);
    expect(stats).toContain("No powernaps in the last 7 days");
  });
});
