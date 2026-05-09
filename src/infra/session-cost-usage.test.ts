import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/paths.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
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

  const withStateDir = async <T>(stateDir: string, fn: () => Promise<T>): Promise<T> =>
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      closeOpenClawStateDatabaseForTest();
      try {
        return await fn();
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });

  const makeRoot = async (prefix: string): Promise<string> => await suiteRootTracker.make(prefix);

  const sessionPath = (_root: string, sessionId: string, agentId = "main") =>
    createSqliteSessionTranscriptLocator({ agentId, sessionId });

  const writeTranscript = (params: {
    agentId?: string;
    sessionId: string;
    transcriptPath?: string;
    events: unknown[];
  }) => {
    const eventTimestamp = params.events
      .map((event) =>
        event && typeof event === "object"
          ? Date.parse(String((event as { timestamp?: unknown }).timestamp ?? ""))
          : NaN,
      )
      .find((value) => Number.isFinite(value));
    replaceSqliteSessionTranscriptEvents({
      agentId: params.agentId ?? "main",
      sessionId: params.sessionId,
      transcriptPath:
        params.transcriptPath ?? sessionPath("", params.sessionId, params.agentId ?? "main"),
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
    closeOpenClawStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  it("discovers sessions from SQLite transcript scopes", async () => {
    const root = await makeRoot("discover");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-discover",
        transcriptPath: sessionPath(root, "sess-discover"),
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
      expect(sessions[0]?.sessionId).toBe("sess-discover");
      expect(sessions[0]?.transcriptLocator).toBe(
        createSqliteSessionTranscriptLocator({
          agentId: "main",
          sessionId: "sess-discover",
        }),
      );
    });
  });

  it("loads aggregate usage from SQLite transcript events", async () => {
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
    });
  });

  it("keeps cache APIs as fresh SQLite-backed compatibility entrypoints", async () => {
    const root = await makeRoot("cache-api");
    await withStateDir(root, async () => {
      writeTranscript({
        sessionId: "sess-cache",
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 3,
            output: 7,
            cost: 0.01,
          }),
        ],
      });

      expect(await refreshCostUsageCache()).toBe("refreshed");
      requestCostUsageCacheRefresh({ sessionTranscripts: [sessionPath(root, "sess-cache")] });
      const summary = await loadCostUsageSummaryFromCache({
        startMs: Date.parse("2026-02-05T00:00:00.000Z"),
        endMs: Date.parse("2026-02-06T00:00:00.000Z"),
      });
      expect(summary.totals.totalTokens).toBe(10);
      expect(summary.cacheStatus).toMatchObject({
        status: "fresh",
        pendingFiles: 0,
        staleFiles: 0,
      });
    });
  });

  it("loads session summary, time series, and logs from SQLite", async () => {
    const root = await makeRoot("session");
    await withStateDir(root, async () => {
      const transcriptPath = sessionPath(root, "sess-summary");
      writeTranscript({
        sessionId: "sess-summary",
        transcriptPath,
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

      const summary = await loadSessionCostSummary({ transcriptLocator: transcriptPath });
      expect(summary).toMatchObject({
        sessionId: "sess-summary",
        totalTokens: 30,
        totalCost: 0.03,
        messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 1 },
      });
      expect(summary?.latency?.avgMs).toBe(2000);
      expect(summary?.modelUsage?.[0]).toMatchObject({ provider: "openai", model: "gpt-5.4" });

      const cached = await loadSessionCostSummaryFromCache({ transcriptLocator: transcriptPath });
      expect(cached.cacheStatus.status).toBe("fresh");
      expect(cached.summary?.totalTokens).toBe(30);

      const timeseries = await loadSessionUsageTimeSeries({ transcriptLocator: transcriptPath });
      expect(timeseries?.points).toHaveLength(1);
      expect(timeseries?.points[0]).toMatchObject({ totalTokens: 30, cumulativeTokens: 30 });

      const logs = await loadSessionLogs({ transcriptLocator: transcriptPath });
      expect(logs?.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(logs?.[0]?.content).toContain("hello");
      expect(logs?.[1]?.content).toContain("[Tool: shell]");
    });
  });

  it("resolves non-main agent transcripts by agent id", async () => {
    const root = await makeRoot("agent");
    await withStateDir(root, async () => {
      writeTranscript({
        agentId: "worker",
        sessionId: "sess-worker",
        transcriptPath: sessionPath(root, "sess-worker", "worker"),
        events: [
          assistantUsage({
            timestamp: "2026-02-05T12:00:00.000Z",
            input: 5,
            output: 6,
            cost: 0.02,
          }),
        ],
      });

      expect(await loadSessionCostSummary({ sessionId: "sess-worker" })).toBeNull();
      const summary = await loadSessionCostSummary({
        agentId: "worker",
        sessionId: "sess-worker",
      });
      expect(summary?.totalTokens).toBe(11);
    });
  });

  it("returns null and stale status for missing SQLite transcripts", async () => {
    const root = await makeRoot("missing");
    await withStateDir(root, async () => {
      expect(
        await loadSessionCostSummary({
          transcriptLocator: createSqliteSessionTranscriptLocator({
            agentId: "main",
            sessionId: "missing",
          }),
        }),
      ).toBeNull();
      const cached = await loadSessionCostSummaryFromCache({
        transcriptLocator: createSqliteSessionTranscriptLocator({
          agentId: "main",
          sessionId: "missing",
        }),
      });
      expect(cached.summary).toBeNull();
      expect(cached.cacheStatus.status).toBe("stale");
    });
  });
});
