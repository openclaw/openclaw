import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../../config/sessions/paths.js";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    getRuntimeConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionEntriesForGateway: vi.fn(() => ({
      databasePath: "(multiple)",
      entries: {},
    })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  const locator = (agentId: string, sessionId: string) =>
    `sqlite-transcript://${agentId}/${sessionId}.jsonl`;
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "main") {
        return [
          {
            sessionId: "s-main",
            sessionFile: locator("main", "s-main"),
            mtime: 100,
            firstUserMessage: "hello",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: locator("opus", "s-opus"),
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummaryFromCache: vi.fn(async () => ({
      summary: {
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
      cacheStatus: {
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      },
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadSessionLogs: vi.fn(async () => []),
  };
});

import {
  discoverAllSessions,
  loadSessionCostSummaryFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionEntriesForGateway } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

const TEST_RUNTIME_CONFIG = {
  agents: {
    list: [{ id: "main" }, { id: "opus" }],
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

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

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

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("discovers sessions across configured agents and keeps agentId in key", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(discoverAllSessions).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(vi.mocked(discoverAllSessions).mock.calls[1]?.[0]?.agentId).toBe("opus");

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(2);

    // Sorted by most recent first (mtime=200 -> opus first).
    expect(sessions[0].key).toBe("agent:opus:s-opus");
    expect(sessions[0].agentId).toBe("opus");
    expect(sessions[1].key).toBe("agent:main:s-main");
    expect(sessions[1].agentId).toBe("main");
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sessionFile = createSqliteSessionTranscriptLocator({
          agentId: "opus",
          sessionId: "s-opus",
        });
        replaceSqliteSessionTranscriptEvents({
          agentId: "opus",
          sessionId: "s-opus",
          transcriptPath: sessionFile,
          events: [{ type: "session", id: "s-opus" }],
        });
        // Swap the store mock for this test: the canonical key differs from the discovered key
        // but points at the same sessionId.
        vi.mocked(loadCombinedSessionEntriesForGateway).mockReturnValue({
          databasePath: "(multiple)",
          entries: {
            [storeKey]: {
              sessionId: "s-opus",
              sessionFile,
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
        expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalled();
        expect(
          vi
            .mocked(loadSessionCostSummaryFromCache)
            .mock.calls.some((call) => call[0]?.agentId === "opus"),
        ).toBe(true);
        expect(
          vi
            .mocked(loadSessionCostSummaryFromCache)
            .mock.calls.every((call) => call[0]?.refreshMode === "sync-when-empty"),
        ).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rolls up known session family ids when historical usage is requested", async () => {
    const storeKey = "agent:opus:main";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const currentSessionFile = createSqliteSessionTranscriptLocator({
          agentId: "opus",
          sessionId: "current",
        });
        const oldSessionFile = createSqliteSessionTranscriptLocator({
          agentId: "opus",
          sessionId: "old",
        });
        replaceSqliteSessionTranscriptEvents({
          agentId: "opus",
          sessionId: "current",
          transcriptPath: currentSessionFile,
          events: [{ type: "session", id: "current" }],
        });
        replaceSqliteSessionTranscriptEvents({
          agentId: "opus",
          sessionId: "old",
          transcriptPath: oldSessionFile,
          events: [{ type: "session", id: "old" }],
        });

        vi.mocked(loadCombinedSessionEntriesForGateway).mockReturnValue({
          databasePath: "(multiple)",
          entries: {
            [storeKey]: {
              sessionId: "current",
              sessionFile: currentSessionFile,
              updatedAt: 1_000,
              usageFamilyKey: storeKey,
              usageFamilySessionIds: ["old", "current"],
            },
          },
        });
        vi.mocked(loadSessionCostSummaryFromCache).mockImplementation(async ({ sessionId }) => ({
          summary: {
            input: sessionId === "old" ? 10 : 20,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: sessionId === "old" ? 10 : 20,
            totalCost: sessionId === "old" ? 0.01 : 0.02,
            inputCost: sessionId === "old" ? 0.01 : 0.02,
            outputCost: 0,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
            messageCounts: {
              total: 1,
              user: 1,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
          },
          cacheStatus: {
            status: "fresh",
            cachedFiles: 1,
            pendingFiles: 0,
            staleFiles: 0,
          },
        }));

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: storeKey,
          groupBy: "family",
          includeHistorical: true,
        });

        expect(respond).toHaveBeenCalledTimes(1);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        const result = respond.mock.calls[0]?.[1] as {
          sessions: Array<{
            key: string;
            scope?: string;
            includedSessionIds?: string[];
            usage?: { totalTokens: number; totalCost: number; messageCounts?: { total: number } };
          }>;
          totals: { totalTokens: number; totalCost: number };
        };
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({
          key: storeKey,
          scope: "family",
          includedSessionIds: ["current", "old"],
        });
        expect(result.sessions[0]?.usage?.totalTokens).toBe(30);
        expect(result.sessions[0]?.usage?.totalCost).toBeCloseTo(0.03);
        expect(result.sessions[0]?.usage?.messageCounts?.total).toBe(2);
        expect(result.totals.totalTokens).toBe(30);
        expect(result.totals.totalCost).toBeCloseTo(0.03);
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
        const sessionFile = createSqliteSessionTranscriptLocator({
          agentId: "opus",
          sessionId: "run-dup",
        });
        replaceSqliteSessionTranscriptEvents({
          agentId: "opus",
          sessionId: "run-dup",
          transcriptPath: sessionFile,
          events: [{ type: "session", id: "run-dup" }],
        });
        vi.mocked(loadCombinedSessionEntriesForGateway).mockReturnValue({
          databasePath: "(multiple)",
          entries: {
            [preferredKey]: {
              sessionId: "run-dup",
              sessionFile,
              updatedAt: 1_000,
            },
            "agent:other:main": {
              sessionId: "run-dup",
              sessionFile,
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
