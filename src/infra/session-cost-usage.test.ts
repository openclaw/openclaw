import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummary,
  loadSessionCostSummaryFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  refreshCostUsageCache,
  requestCostUsageCacheRefresh,
} from "./session-cost-usage.js";

describe("session cost usage", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-session-cost-" });

  const closeDatabases = () => {
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
  };

  const withStateDir = async <T>(stateDir: string, fn: () => Promise<T>): Promise<T> =>
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      closeDatabases();
      try {
        return await fn();
      } finally {
        closeDatabases();
      }
    });

  const makeRoot = async (prefix: string): Promise<string> => await suiteRootTracker.make(prefix);

  const writeTranscript = (params: { agentId?: string; sessionId: string; events: unknown[] }) => {
    const eventTimestamp = params.events
      .map((event) =>
        event &&
        typeof event === "object" &&
        typeof (event as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((event as { timestamp: string }).timestamp)
          : Number.NaN,
      )
      .find((value) => Number.isFinite(value));
    replaceSqliteSessionTranscriptEvents({
      agentId: params.agentId ?? "main",
      sessionId: params.sessionId,
      events: [{ type: "session", version: 1, id: params.sessionId }, ...params.events],
      ...(eventTimestamp !== undefined ? { now: () => eventTimestamp } : {}),
    });
  };

  const assistantUsage = (params: {
    timestamp: string;
    input: number;
    output: number;
    totalTokens?: number;
    cost?: number;
    provider?: string;
    model?: string;
    durationMs?: number;
  }) => ({
    type: "message",
    timestamp: params.timestamp,
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-5.4",
    usage: {
      input: params.input,
      output: params.output,
      totalTokens: params.totalTokens ?? params.input + params.output,
      ...(params.cost === undefined ? {} : { cost: { total: params.cost } }),
    },
    message: {
      role: "assistant",
      provider: params.provider ?? "openai",
      model: params.model ?? "gpt-5.4",
      durationMs: params.durationMs,
      usage: {
        input: params.input,
        output: params.output,
        totalTokens: params.totalTokens ?? params.input + params.output,
        ...(params.cost === undefined ? {} : { cost: { total: params.cost } }),
      },
    },
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    closeDatabases();
    await suiteRootTracker.cleanup();
  });

  it("discovers sessions by durable SQLite scope", async () => {
    const root = await makeRoot("discover");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-discover",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "Summarize the last build" },
          },
        ],
      });

      const sessions = await discoverAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        agentId: "main",
        sessionId: "sess-discover",
        firstUserMessage: "Summarize the last build",
      });
    });
  });

  it("loads aggregate usage directly from SQLite transcript events", async () => {
    const root = await makeRoot("aggregate");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-aggregate",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 10,
            output: 20,
            cost: 0.03,
          }),
        ],
      });

      const summary = await loadCostUsageSummary({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
      });
      expect(summary.daily).toHaveLength(1);
      expect(summary.totals.totalTokens).toBe(30);
      expect(summary.totals.totalCost).toBeCloseTo(0.03, 5);

      const cached = await loadCostUsageSummaryFromCache({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
        requestRefresh: false,
      });
      expect(cached.cacheStatus).toMatchObject({
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      });
      expect(await refreshCostUsageCache()).toBe("refreshed");
      requestCostUsageCacheRefresh();
    });
  });

  it("loads session summary, time series, and logs by agent/session id", async () => {
    const root = await makeRoot("session");
    await withStateDir(root, async () => {
      writeTranscript({
        agentId: "worker",
        sessionId: "sess-summary",
        events: [
          {
            type: "message",
            timestamp: "2026-02-05T12:00:00.000Z",
            message: { role: "user", content: "[OpenClaw inbound]\nhello" },
          },
          {
            ...assistantUsage({
              timestamp: "2026-02-05T12:00:02.000Z",
              input: 10,
              output: 20,
              cost: 0.03,
              durationMs: 2000,
            }),
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-5.4",
              durationMs: 2000,
              content: [
                { type: "tool_use", name: "shell" },
                { type: "text", text: "done" },
              ],
              usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.03 } },
            },
          },
        ],
      });

      expect(await loadSessionCostSummary({ sessionId: "sess-summary" })).toBeNull();

      const summary = await loadSessionCostSummary({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(summary).toMatchObject({
        agentId: "worker",
        sessionId: "sess-summary",
        totalTokens: 30,
        totalCost: 0.03,
        messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 1 },
      });
      expect(summary?.latency?.avgMs).toBe(2000);
      expect(summary?.modelUsage?.[0]).toMatchObject({ provider: "openai", model: "gpt-5.4" });

      const cached = await loadSessionCostSummaryFromCache({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(cached.cacheStatus.status).toBe("fresh");
      expect(cached.summary?.totalTokens).toBe(30);

      const timeseries = await loadSessionUsageTimeSeries({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(timeseries).toMatchObject({ sessionId: "sess-summary" });
      expect(timeseries?.points).toHaveLength(1);
      expect(timeseries?.points[0]).toMatchObject({ totalTokens: 30, cumulativeTokens: 30 });

      const logs = await loadSessionLogs({
        agentId: "worker",
        sessionId: "sess-summary",
      });
      expect(logs?.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(logs?.[0]?.content).toContain("hello");
      expect(logs?.[1]?.content).toContain("[Tool: shell]");
    });
  });

  it("reports stale session cache status for missing SQLite transcripts", async () => {
    const root = await makeRoot("missing");
    await withStateDir(root, async () => {
      expect(await loadSessionCostSummary({ agentId: "main", sessionId: "missing" })).toBeNull();

      const cached = await loadSessionCostSummaryFromCache({
        agentId: "main",
        sessionId: "missing",
      });
      expect(cached.summary).toBeNull();
      expect(cached.cacheStatus).toMatchObject({
        status: "stale",
        cachedFiles: 0,
        pendingFiles: 0,
        staleFiles: 1,
      });
    });
  });
});
