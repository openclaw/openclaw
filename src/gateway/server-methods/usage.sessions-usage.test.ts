import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    getRuntimeConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "ops", default: true }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "ops") {
        return [
          {
            sessionId: "s-ops",
            sessionFile: "/tmp/agents/ops/sessions/s-ops.jsonl",
            mtime: 100,
            firstUserMessage: "hello",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummary: vi.fn(async () => ({
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
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      days: 2,
      daily: [],
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
    loadSessionLogs: vi.fn(async () => []),
  };
});

import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { __test, usageHandlers } from "./usage.js";

const TEST_RUNTIME_CONFIG = {
  agents: {
    list: [{ id: "ops", default: true }, { id: "opus" }],
  },
  session: {},
};

async function runSessionsUsage(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

async function runSessionsUsageTimeseries(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.timeseries"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);
  return respond;
}

async function runSessionsUsageLogs(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.logs"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);
  return respond;
}

async function runUsageCost(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["usage.cost"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
  return respond;
}

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function createCostTotals(params: { totalTokens: number; totalCost: number }) {
  return {
    input: params.totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: params.totalTokens,
    totalCost: params.totalCost,
    inputCost: params.totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function createCostSummary(
  entries: Array<{ date: string; totalTokens: number; totalCost: number }>,
) {
  const totals = createCostTotals({ totalTokens: 0, totalCost: 0 });
  const daily = entries.map((entry) => {
    const dayTotals = createCostTotals({
      totalTokens: entry.totalTokens,
      totalCost: entry.totalCost,
    });
    totals.input += dayTotals.input;
    totals.totalTokens += dayTotals.totalTokens;
    totals.totalCost += dayTotals.totalCost;
    totals.inputCost += dayTotals.inputCost;
    return { date: entry.date, ...dayTotals };
  });
  return {
    updatedAt: Date.now(),
    days: 2,
    daily,
    totals,
  };
}

function expectSuccessfulSessionsUsage(
  respond: ReturnType<typeof vi.fn>,
): Array<{ key: string; agentId: string }> {
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  const result = respond.mock.calls[0]?.[1] as {
    sessions: Array<{ key: string; agentId: string }>;
  };
  return result.sessions;
}

describe("usage.cost", () => {
  beforeEach(() => {
    __test.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("aggregates cost usage across configured agents when no agentId is requested", async () => {
    vi.mocked(loadCostUsageSummary).mockImplementation(async (params) => {
      if (params?.agentId === "ops") {
        return createCostSummary([{ date: "2026-02-01", totalTokens: 10, totalCost: 1 }]);
      }
      if (params?.agentId === "opus") {
        return createCostSummary([
          { date: "2026-02-01", totalTokens: 20, totalCost: 2 },
          { date: "2026-02-02", totalTokens: 5, totalCost: 0.5 },
        ]);
      }
      return createCostSummary([]);
    });

    const respond = await runUsageCost(BASE_USAGE_RANGE);

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadCostUsageSummary).mock.calls.map((call) => call[0]?.agentId)).toEqual([
      "ops",
      "opus",
    ]);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const summary = respond.mock.calls[0]?.[1] as ReturnType<typeof createCostSummary>;
    expect(summary.daily).toEqual([
      expect.objectContaining({ date: "2026-02-01", totalTokens: 30, totalCost: 3 }),
      expect.objectContaining({ date: "2026-02-02", totalTokens: 5, totalCost: 0.5 }),
    ]);
    expect(summary.days).toBe(2);
    expect(summary.totals.totalTokens).toBe(35);
    expect(summary.totals.totalCost).toBe(3.5);
  });

  it("keeps aggregated cost usage available when one configured agent scan fails", async () => {
    vi.mocked(loadCostUsageSummary).mockImplementation(async (params) => {
      if (params?.agentId === "ops") {
        throw new Error("unreadable transcript");
      }
      return createCostSummary([{ date: "2026-02-02", totalTokens: 5, totalCost: 0.5 }]);
    });

    const respond = await runUsageCost(BASE_USAGE_RANGE);

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const summary = respond.mock.calls[0]?.[1] as ReturnType<typeof createCostSummary>;
    expect(summary.daily).toEqual([
      expect.objectContaining({ date: "2026-02-02", totalTokens: 5, totalCost: 0.5 }),
    ]);
    expect(summary.totals.totalTokens).toBe(5);
    expect(summary.totals.totalCost).toBe(0.5);
  });

  it("keeps cost usage scoped to the requested agentId", async () => {
    vi.mocked(loadCostUsageSummary).mockResolvedValue(
      createCostSummary([{ date: "2026-02-01", totalTokens: 20, totalCost: 2 }]),
    );

    const respond = await runUsageCost({ ...BASE_USAGE_RANGE, agentId: "opus" });

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadCostUsageSummary).mock.calls[0]?.[0]?.agentId).toBe("opus");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const summary = respond.mock.calls[0]?.[1] as ReturnType<typeof createCostSummary>;
    expect(summary.totals.totalTokens).toBe(20);
    expect(summary.totals.totalCost).toBe(2);
  });

  it("rejects explicit agentIds outside the configured gateway scope", async () => {
    const respond = await runUsageCost({ ...BASE_USAGE_RANGE, agentId: "retired" });

    expect(vi.mocked(loadCostUsageSummary)).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'unknown agent id "retired"',
    });
  });
});

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("discovers sessions across configured agents and keeps agentId in key", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(discoverAllSessions).mock.calls[0]?.[0]?.agentId).toBe("ops");
    expect(vi.mocked(discoverAllSessions).mock.calls[1]?.[0]?.agentId).toBe("opus");

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(2);

    // Sorted by most recent first (mtime=200 -> opus first).
    expect(sessions[0].key).toBe("agent:opus:s-opus");
    expect(sessions[0].agentId).toBe("opus");
    expect(sessions[1].key).toBe("agent:ops:s-ops");
    expect(sessions[1].agentId).toBe("ops");
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "s-opus.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        // Swap the store mock for this test: the canonical key differs from the discovered key
        // but points at the same sessionId.
        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [storeKey]: {
              sessionId: "s-opus",
              sessionFile: "s-opus.jsonl",
              label: "Named session",
              updatedAt: 999,
            },
          },
        });

        // Query via discovered key: agent:<id>:<sessionId>
        const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "agent:opus:s-opus" });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(storeKey);
        expect(vi.mocked(loadSessionCostSummary)).toHaveBeenCalled();
        expect(
          vi.mocked(loadSessionCostSummary).mock.calls.some((call) => call[0]?.agentId === "opus"),
        ).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
    const preferredKey = "agent:opus:acp:run-dup";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "run-dup.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [preferredKey]: {
              sessionId: "run-dup",
              sessionFile: "run-dup.jsonl",
              updatedAt: 1_000,
            },
            "agent:other:main": {
              sessionId: "run-dup",
              sessionFile: "run-dup.jsonl",
              updatedAt: 2_000,
            },
          },
        });

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: "agent:opus:run-dup",
        });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(preferredKey);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:../../etc/passwd",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const error = respond.mock.calls[0]?.[2] as { message?: string } | undefined;
    expect(error?.message).toContain("Invalid session reference");
  });

  it("passes parsed agentId into sessions.usage.timeseries", async () => {
    await runSessionsUsageTimeseries({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionUsageTimeSeries).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("passes parsed agentId into sessions.usage.logs", async () => {
    await runSessionsUsageLogs({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionLogs).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const timeseriesRespond = await runSessionsUsageTimeseries({
      key: "agent:opus:../../etc/passwd",
    });
    expect(timeseriesRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );

    const logsRespond = await runSessionsUsageLogs({
      key: "agent:opus:../../etc/passwd",
    });
    expect(logsRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );
  });
});
