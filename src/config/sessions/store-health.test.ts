import { describe, expect, it } from "vitest";
import { evaluateSessionStoreHealth, shouldAdmitSessionStoreWork } from "./store-health.js";
import type { SessionStoreOperationMetric } from "./store-observability.js";

function metric(overrides: Partial<SessionStoreOperationMetric> = {}): SessionStoreOperationMetric {
  return {
    backend: "postgres",
    operation: "readEntry",
    storePath: "/state/sessions.json",
    ok: true,
    startedAtMs: 1_000,
    durationMs: 10,
    ...overrides,
  };
}

describe("session-store health evaluator", () => {
  it("fails closed when metrics are missing, stale, or insufficient", () => {
    expect(
      evaluateSessionStoreHealth({
        metrics: [],
        nowMs: 10_000,
        budget: { maxMetricsAgeMs: 1_000, minRecentOperations: 1 },
      }),
    ).toMatchObject({
      ok: false,
      denials: [
        expect.objectContaining({ code: "missing_metrics" }),
        expect.objectContaining({ code: "insufficient_metrics" }),
      ],
    });

    expect(
      evaluateSessionStoreHealth({
        metrics: [metric({ startedAtMs: 1_000 })],
        nowMs: 10_000,
        budget: { maxMetricsAgeMs: 1_000 },
      }),
    ).toMatchObject({
      ok: false,
      denials: [expect.objectContaining({ code: "stale_metrics", observed: 9_000 })],
    });
  });

  it("denies work for latency, recent failures, and error-rate budget breaches", () => {
    const health = evaluateSessionStoreHealth({
      metrics: [
        metric({ startedAtMs: 9_900, durationMs: 250 }),
        metric({ startedAtMs: 9_950, ok: false, durationMs: 20, errorName: "Error" }),
        metric({ startedAtMs: 9_980, ok: false, durationMs: 30, errorName: "TypeError" }),
      ],
      nowMs: 10_000,
      budget: {
        maxMetricsAgeMs: 1_000,
        maxOperationDurationMs: 100,
        maxRecentFailures: 1,
        maxErrorRate: 0.5,
      },
    });

    expect(health).toMatchObject({
      ok: false,
      recentOperations: 3,
      failedOperations: 2,
      denials: [
        expect.objectContaining({ code: "operation_latency", observed: 250, limit: 100 }),
        expect.objectContaining({ code: "operation_errors", observed: 2, limit: 1 }),
        expect.objectContaining({ code: "operation_error_rate" }),
      ],
    });
  });

  it("denies work when bounded-read or runtime health budgets are exceeded", () => {
    const decision = shouldAdmitSessionStoreWork({
      metrics: [
        metric({
          operation: "listEntries",
          startedAtMs: 9_900,
          entryCount: 250,
          totalCount: 20_000,
          hasMore: true,
        }),
        metric({
          operation: "listTranscriptChunks",
          startedAtMs: 9_950,
          chunkCount: 150,
          byteCount: 1_500_000,
          totalCount: 2_500,
          hasMore: true,
        }),
        metric({
          operation: "listSessionTurns",
          startedAtMs: 9_975,
          turnCount: 300,
          totalCount: 3_000,
          hasMore: true,
        }),
      ],
      runtime: {
        eventLoopLagMs: 125,
        rssBytes: 2_000,
        cpuPercent: 95,
      },
      nowMs: 10_000,
      budget: {
        maxMetricsAgeMs: 1_000,
        maxListPageEntries: 100,
        maxListTotalCount: 10_000,
        maxTranscriptChunkPageEntries: 100,
        maxTranscriptChunkPageBytes: 1_000_000,
        maxTranscriptChunkTotalCount: 1_000,
        maxSessionTurnPageEntries: 100,
        maxSessionTurnTotalCount: 1_000,
        maxEventLoopLagMs: 50,
        maxRssBytes: 1_000,
        maxCpuPercent: 80,
      },
    });

    expect(decision).toMatchObject({
      admitted: false,
      reason: "session_store_health",
      health: {
        ok: false,
        denials: [
          expect.objectContaining({ code: "list_page_size", observed: 250, limit: 100 }),
          expect.objectContaining({ code: "list_total_count", observed: 20_000, limit: 10_000 }),
          expect.objectContaining({
            code: "transcript_chunk_page_size",
            observed: 150,
            limit: 100,
          }),
          expect.objectContaining({
            code: "transcript_chunk_page_bytes",
            observed: 1_500_000,
            limit: 1_000_000,
          }),
          expect.objectContaining({
            code: "transcript_chunk_total_count",
            observed: 2_500,
            limit: 1_000,
          }),
          expect.objectContaining({
            code: "session_turn_page_size",
            observed: 300,
            limit: 100,
          }),
          expect.objectContaining({
            code: "session_turn_total_count",
            observed: 3_000,
            limit: 1_000,
          }),
          expect.objectContaining({ code: "event_loop_lag", observed: 125, limit: 50 }),
          expect.objectContaining({ code: "rss", observed: 2_000, limit: 1_000 }),
          expect.objectContaining({ code: "cpu", observed: 95, limit: 80 }),
        ],
      },
    });
  });

  it("admits work when storage metrics and runtime samples are inside budget", () => {
    expect(
      shouldAdmitSessionStoreWork({
        metrics: [
          metric({
            operation: "listEntries",
            startedAtMs: 9_900,
            durationMs: 25,
            entryCount: 50,
            totalCount: 500,
            hasMore: true,
          }),
          metric({
            operation: "listTranscriptChunks",
            startedAtMs: 9_925,
            durationMs: 20,
            chunkCount: 10,
            byteCount: 64_000,
            totalCount: 100,
            hasMore: false,
          }),
          metric({
            operation: "listSessionTurns",
            startedAtMs: 9_950,
            durationMs: 12,
            turnCount: 20,
            totalCount: 200,
            hasMore: true,
          }),
          metric({ operation: "readEntry", startedAtMs: 9_980, durationMs: 5 }),
        ],
        runtime: { eventLoopLagMs: 10, rssBytes: 500, cpuPercent: 20 },
        nowMs: 10_000,
        budget: {
          maxMetricsAgeMs: 1_000,
          minRecentOperations: 2,
          maxOperationDurationMs: 100,
          maxRecentFailures: 0,
          maxErrorRate: 0,
          maxListPageEntries: 100,
          maxListTotalCount: 1_000,
          maxTranscriptChunkPageEntries: 100,
          maxTranscriptChunkPageBytes: 128_000,
          maxTranscriptChunkTotalCount: 1_000,
          maxSessionTurnPageEntries: 100,
          maxSessionTurnTotalCount: 1_000,
          maxEventLoopLagMs: 50,
          maxRssBytes: 1_000,
          maxCpuPercent: 80,
        },
      }),
    ).toMatchObject({ admitted: true, health: { ok: true, recentOperations: 4 } });
  });
});
