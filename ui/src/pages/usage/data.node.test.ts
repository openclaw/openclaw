// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadSessionLogs, loadSessionTimeSeries, loadUsage, type UsageState } from "./data.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<UsageState> = {}): UsageState {
  return {
    client: { request } as unknown as UsageState["client"],
    connected: true,
    usageLoading: false,
    usageResult: null,
    usageCostSummary: null,
    usageError: null,
    usageStartDate: "2026-02-16",
    usageEndDate: "2026-02-16",
    usageScope: "family",
    usageAgentId: null,
    usageQuery: "",
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageTimeSeries: null,
    usageTimeSeriesLoading: false,
    usageTimeSeriesCursorStart: null,
    usageTimeSeriesCursorEnd: null,
    usageSessionLogs: null,
    usageSessionLogsLoading: false,
    usageTimeZone: "utc",
    ...overrides,
  };
}

describe("usage controller", () => {
  it("requests canonical all-agent usage and cost params", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request);

    await loadUsage(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      agentScope: "all",
      mode: "utc",
      groupBy: "family",
      includeHistorical: true,
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      agentScope: "all",
      mode: "utc",
    });
  });

  it("passes a selected agent to usage and cost", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState(request, { usageAgentId: "research" });

    await loadUsage(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      agentId: "research",
      mode: "utc",
      groupBy: "family",
      includeHistorical: true,
      limit: 1000,
      includeContextWeight: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "usage.cost", {
      startDate: "2026-02-16",
      endDate: "2026-02-16",
      agentId: "research",
      mode: "utc",
    });
  });

  it("captures request errors", async () => {
    const request = vi.fn(async () => {
      throw new Error("request failed");
    });
    const state = createState(request);

    await loadUsage(state);

    expect(state.usageError).toBe("request failed");
  });

  it("keeps optional detail loaders resilient", async () => {
    const request = vi.fn(async () => {
      throw new Error("optional endpoint unavailable");
    });
    const state = createState(request);

    await loadSessionTimeSeries(state, "session-1");
    await loadSessionLogs(state, "session-1");

    expect(state.usageTimeSeries).toBeNull();
    expect(state.usageSessionLogs).toBeNull();
    expect(state.usageTimeSeriesLoading).toBe(false);
    expect(state.usageSessionLogsLoading).toBe(false);
  });

  it("normalizes malformed usage logs", async () => {
    const request = vi.fn(async () => ({ logs: "unexpected-shape" }));
    const state = createState(request);

    await loadSessionLogs(state, "session-1");

    expect(state.usageSessionLogs).toBeNull();
    expect(state.usageSessionLogsLoading).toBe(false);
  });
});
