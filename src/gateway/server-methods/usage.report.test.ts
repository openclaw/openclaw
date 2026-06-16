import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      list: [{ id: "alpha" }, { id: "beta" }],
    },
    session: {},
  })),
}));

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      days: 30,
      daily: [
        {
          date: "2026-03-01",
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          totalCost: 1.25,
          inputCost: 0.75,
          outputCost: 0.5,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 2,
        },
      ],
      totals: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        totalCost: 1.25,
        inputCost: 0.75,
        outputCost: 0.5,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 2,
      },
    })),
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "alpha") {
        return [{ sessionId: "a1", sessionFile: "/tmp/alpha-a1.jsonl", mtime: 100 }];
      }
      if (params?.agentId === "beta") {
        return [{ sessionId: "b1", sessionFile: "/tmp/beta-b1.jsonl", mtime: 200 }];
      }
      return [];
    }),
    loadSessionCostSummary: vi.fn(async (params?: { sessionFile?: string }) => {
      if (params?.sessionFile?.includes("alpha")) {
        return {
          input: 60,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 90,
          totalCost: 0.8,
          inputCost: 0.5,
          outputCost: 0.3,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 1,
          modelUsage: [
            {
              provider: "openai",
              model: "gpt-4.1",
              count: 2,
              totals: {
                input: 60,
                output: 30,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 90,
                totalCost: 0.8,
                inputCost: 0.5,
                outputCost: 0.3,
                cacheReadCost: 0,
                cacheWriteCost: 0,
                missingCostEntries: 1,
              },
            },
          ],
        };
      }

      return {
        input: 40,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        totalCost: 0.45,
        inputCost: 0.25,
        outputCost: 0.2,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        modelUsage: [
          {
            provider: "openai",
            model: "gpt-4.1",
            count: 1,
            totals: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              totalCost: 0.15,
              inputCost: 0.08,
              outputCost: 0.07,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 0,
            },
          },
          {
            provider: "anthropic",
            model: "claude-sonnet",
            count: 1,
            totals: {
              input: 30,
              output: 15,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 45,
              totalCost: 0.3,
              inputCost: 0.17,
              outputCost: 0.13,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 1,
            },
          },
        ],
      };
    }),
  };
});

import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { __test, usageHandlers, type UsageReportSummary } from "./usage.js";

describe("usage.report", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __test.costUsageCache.clear();
    __test.usageReportCache.clear();
  });

  it("aggregates model and provider totals across all matching sessions", async () => {
    const respond = vi.fn();

    await usageHandlers["usage.report"]({
      respond,
      params: { startDate: "2026-03-01", endDate: "2026-03-30" },
    } as unknown as Parameters<(typeof usageHandlers)["usage.report"]>[0]);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);

    const summary = respond.mock.calls[0]?.[1] as UsageReportSummary;
    expect(summary.startDate).toBe("2026-03-01");
    expect(summary.endDate).toBe("2026-03-30");
    expect(summary.daily).toHaveLength(1);
    expect(summary.totals.totalTokens).toBe(150);
    expect(summary.totals.totalCost).toBe(1.25);
    expect(summary.totals.missingCostEntries).toBe(2);

    expect(summary.byModel).toHaveLength(2);
    expect(summary.byModel[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4.1",
      count: 3,
    });
    expect(summary.byModel[0]?.totals.totalTokens).toBe(105);
    expect(summary.byModel[0]?.totals.totalCost).toBeCloseTo(0.95);
    expect(summary.byModel[0]?.totals.missingCostEntries).toBe(1);
    expect(summary.byModel[1]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet",
      count: 1,
    });
    expect(summary.byModel[1]?.totals.missingCostEntries).toBe(1);

    expect(summary.byProvider).toHaveLength(2);
    expect(summary.byProvider[0]).toMatchObject({ provider: "openai", count: 3 });
    expect(summary.byProvider[0]?.totals.totalCost).toBeCloseTo(0.95);
    expect(summary.byProvider[0]?.totals.missingCostEntries).toBe(1);
    expect(summary.byProvider[1]).toMatchObject({ provider: "anthropic", count: 1 });
    expect(summary.byProvider[1]?.totals.missingCostEntries).toBe(1);

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(loadSessionCostSummary)
        .mock.calls.map((call) => call[0]?.agentId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["alpha", "beta"]);
  });
});
