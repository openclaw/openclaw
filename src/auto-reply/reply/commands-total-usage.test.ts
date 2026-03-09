import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadCostUsageSummaryMock = vi.hoisted(() =>
  vi.fn(async () => ({
    updatedAt: Date.now(),
    days: 1,
    daily: [],
    models: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
  })),
);

vi.mock("../../infra/session-cost-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/session-cost-usage.js")>();
  return {
    ...actual,
    loadCostUsageSummary: (params: unknown) => loadCostUsageSummaryMock(params),
  };
});

const { handleTotalUsageCommand } = await import("./commands-session.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/total_usage", () => {
  beforeEach(() => {
    loadCostUsageSummaryMock.mockClear();
    vi.useRealTimers();
  });

  it("uses an unbounded lower bound for /total_usage all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    const result = await handleTotalUsageCommand(
      buildCommandTestParams("/total_usage all", baseCfg),
      true,
    );

    expect(loadCostUsageSummaryMock).toHaveBeenCalledWith({
      startMs: 0,
      endMs: Date.now(),
      config: baseCfg,
    });
    expect(result?.reply?.text).toContain("Usage summary (All time)");
  });
});
