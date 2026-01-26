import { describe, expect, it, vi } from "vitest";
import type { AnalyticsState } from "./analytics";
import { loadAnalytics } from "./analytics";
import type { CostUsageSummary } from "../views/analytics";

describe("analytics controller", () => {
  it("AnalyticsState has expected properties", () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        updatedAt: Date.now(),
        days: 30,
        daily: [],
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          totalCost: 0,
          missingCostEntries: 0,
        },
      } as CostUsageSummary),
    };

    const state: AnalyticsState = {
      client: mockClient as any,
      analyticsLoading: false,
      analyticsError: null,
      analyticsData: null,
      analyticsQuota: null,
      analyticsDays: 30,
    };

    expect(state.analyticsLoading).toBe(false);
    expect(state.analyticsDays).toBe(30);
    expect(state.analyticsData).toBeNull();
    expect(state.analyticsQuota).toBeNull();
  });

  it("should have valid day options", () => {
    const validDays = [7, 14, 30, 90];
    validDays.forEach((days) => {
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(90);
    });
  });

  it("loadAnalytics sets data and quota on success", async () => {
    const mockCostData: CostUsageSummary = {
      updatedAt: Date.now(),
      days: 30,
      daily: [
        {
          date: "2026-01-26",
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheWrite: 100,
          totalTokens: 1800,
          totalCost: 0.05,
          missingCostEntries: 0,
        },
      ],
      totals: {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
        totalTokens: 1800,
        totalCost: 0.05,
        missingCostEntries: 0,
      },
    };

    const mockQuotaData = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 42 },
            { label: "Week", usedPercent: 25 },
          ],
        },
      ],
    };

    const mockClient = {
      request: vi.fn().mockImplementation((method: string) => {
        if (method === "usage.cost") return Promise.resolve(mockCostData);
        if (method === "usage.status") return Promise.resolve(mockQuotaData);
        return Promise.reject(new Error("Unknown method"));
      }),
    };

    const state: AnalyticsState = {
      client: mockClient as any,
      analyticsLoading: false,
      analyticsError: null,
      analyticsData: null,
      analyticsQuota: null,
      analyticsDays: 30,
    };

    await loadAnalytics(state);

    expect(mockClient.request).toHaveBeenCalledWith("usage.cost", { days: 30 });
    expect(mockClient.request).toHaveBeenCalledWith("usage.status", {});
    expect(state.analyticsData).toEqual(mockCostData);
    expect(state.analyticsQuota).toHaveLength(1);
    expect(state.analyticsQuota![0].displayName).toBe("Claude");
    expect(state.analyticsError).toBeNull();
    expect(state.analyticsLoading).toBe(false);
  });

  it("loadAnalytics sets error on failure", async () => {
    const mockClient = {
      request: vi.fn().mockRejectedValue(new Error("Network error")),
    };

    const state: AnalyticsState = {
      client: mockClient as any,
      analyticsLoading: false,
      analyticsError: null,
      analyticsData: null,
      analyticsQuota: null,
      analyticsDays: 7,
    };

    await loadAnalytics(state);

    expect(state.analyticsData).toBeNull();
    expect(state.analyticsError).toBe("Network error");
    expect(state.analyticsLoading).toBe(false);
  });
});
