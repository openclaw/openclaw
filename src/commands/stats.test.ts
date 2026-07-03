// Stats usage command tests cover aggregation math, filters, JSON output, and ordering.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRuntime,
  mockSessionsConfig,
  resetMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

// Disable colors for deterministic output.
process.env.FORCE_COLOR = "0";

mockSessionsConfig();

import { statsUsageCommand } from "./stats.js";

type StatsJson = {
  totals: {
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  provider: string | null;
  since: string | null;
  byProvider: Array<{
    name: string;
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
};

async function runStatsJson(
  store: string,
  opts?: { provider?: string; since?: string; until?: string },
): Promise<StatsJson> {
  const { runtime, logs } = makeRuntime();
  try {
    await statsUsageCommand({ store, json: true, ...opts }, runtime);
  } finally {
    fs.rmSync(store, { force: true });
  }
  return JSON.parse(logs[0] ?? "{}") as StatsJson;
}

describe("statsUsageCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("aggregates token usage and cost across sessions", async () => {
    const store = writeStore({
      a: {
        sessionId: "a",
        updatedAt: Date.now(),
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.25,
        modelProvider: "anthropic",
      },
      b: {
        sessionId: "b",
        updatedAt: Date.now(),
        inputTokens: 200,
        outputTokens: 100,
        estimatedCostUsd: 0.05,
        modelProvider: "openai",
      },
    });

    const payload = await runStatsJson(store);
    expect(payload.totals.sessions).toBe(2);
    expect(payload.totals.inputTokens).toBe(1200);
    expect(payload.totals.outputTokens).toBe(600);
    expect(payload.totals.totalTokens).toBe(1800);
    expect(payload.totals.estimatedCostUsd).toBeCloseTo(0.3, 10);
  });

  it("orders provider breakdown by total tokens descending", async () => {
    const store = writeStore({
      a: {
        sessionId: "a",
        updatedAt: Date.now(),
        inputTokens: 10,
        outputTokens: 5,
        modelProvider: "small",
        model: "m",
      },
      b: {
        sessionId: "b",
        updatedAt: Date.now(),
        inputTokens: 5000,
        outputTokens: 5000,
        modelProvider: "big",
        model: "m",
      },
      c: {
        sessionId: "c",
        updatedAt: Date.now(),
        inputTokens: 100,
        outputTokens: 100,
        modelProvider: "mid",
        model: "m",
      },
    });

    const payload = await runStatsJson(store);
    expect(payload.byProvider.map((row) => row.name)).toEqual(["big", "mid", "small"]);
  });

  it("filters by provider", async () => {
    const store = writeStore({
      a: {
        sessionId: "a",
        updatedAt: Date.now(),
        inputTokens: 1000,
        outputTokens: 0,
        modelProvider: "anthropic",
        model: "m",
      },
      b: {
        sessionId: "b",
        updatedAt: Date.now(),
        inputTokens: 7,
        outputTokens: 3,
        modelProvider: "openai",
        model: "m",
      },
    });

    const payload = await runStatsJson(store, { provider: "openai" });
    expect(payload.provider).toBe("openai");
    expect(payload.totals.sessions).toBe(1);
    expect(payload.totals.totalTokens).toBe(10);
    expect(payload.byProvider.map((row) => row.name)).toEqual(["openai"]);
  });

  it("filters by --since duration window", async () => {
    const store = writeStore({
      recent: {
        sessionId: "recent",
        updatedAt: Date.now() - 60_000,
        inputTokens: 40,
        outputTokens: 10,
      },
      stale: {
        sessionId: "stale",
        updatedAt: Date.now() - 10 * 86_400_000,
        inputTokens: 999,
        outputTokens: 999,
      },
    });

    const payload = await runStatsJson(store, { since: "7d" });
    expect(payload.totals.sessions).toBe(1);
    expect(payload.totals.totalTokens).toBe(50);
    expect(payload.since).not.toBeNull();
  });

  it("counts sessions without recorded usage as zero tokens", async () => {
    const store = writeStore({
      a: { sessionId: "a", updatedAt: Date.now(), modelProvider: "anthropic" },
    });

    const { runtime, logs } = makeRuntime();
    await statsUsageCommand({ store }, runtime);
    fs.rmSync(store, { force: true });

    const text = logs.join("\n");
    expect(text).toContain("Sessions: 1");
    expect(text).toContain("Total tokens: 0");
  });
});
