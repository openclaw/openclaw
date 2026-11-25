import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  createUsageTranscriptEntry,
  overviewRows,
} from "./session-cost-usage-fixtures.test-support.js";
import { observeUsageWorkerReads } from "./session-cost-usage-worker-io.test-support.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache,
} from "./session-cost-usage.js";

const transcript = (events: Array<[string, number, string]>) =>
  events
    .map(([timestamp, tokens, model]) =>
      JSON.stringify(
        createUsageTranscriptEntry(tokens, { timestamp, cost: tokens / 100, provider: "p", model }),
      ),
    )
    .join("\n") + "\n";

it("folds committed quarter rows per report calendar without reading transcripts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-overview-quarters";
    const sessionsDir = state.sessionsDir(agentId);
    await fs.mkdir(sessionsDir, { recursive: true });
    // IST (+05:30) midnight is 18:30Z; Nepal (+05:45) midnight is 18:15Z.
    const first = path.join(sessionsDir, "overview-first.jsonl");
    const second = path.join(sessionsDir, "overview-second.jsonl");
    // New York leaves DST at 06:00Z on 2026-11-01; local midnights are 04:00Z then 05:00Z.
    const dst = path.join(sessionsDir, "overview-dst.jsonl");
    await fs.writeFile(
      first,
      transcript([
        ["2026-09-18T18:14:00Z", 2, "a"],
        ["2026-09-18T18:20:00Z", 3, "a"],
        ["2026-09-18T18:40:00Z", 5, "b"],
      ]),
    );
    await fs.writeFile(second, transcript([["2026-09-19T01:00:00Z", 7, "b"]]));
    await fs.writeFile(
      dst,
      transcript([
        ["2026-11-01T03:59:00Z", 1, "a"],
        ["2026-11-01T04:01:00Z", 10, "a"],
        ["2026-11-02T04:30:00Z", 100, "a"],
        ["2026-11-02T05:01:00Z", 1000, "a"],
      ]),
    );
    const sessionFiles = [first, second, dst];
    await refreshCostUsageCacheForAgent({ config: {}, agentId, sessionFiles });
    const probe = await observeUsageWorkerReads(state.stateDir, sessionFiles);
    const family = [[{ sessionFile: first }, { sessionFile: second }]];
    const kolkata = {
      agentId,
      families: family,
      startMs: Date.parse("2026-09-18T00:00:00+05:30"),
      endMs: Date.parse("2026-09-20T00:00:00+05:30") - 1,
      dayBucket: { mode: "time-zone" as const, timeZone: "Asia/Kolkata" },
    };
    await probe.run(async () => {
      const overview = overviewRows(await loadSessionUsageOverviewFromCache(kolkata));
      expect(overview).toMatchObject({
        computing: [false],
        summarizing: 0,
        cacheStatus: { status: "fresh", cachedFiles: 2, pendingFiles: 0 },
      });
      const row = overview.rows[0]!;
      expect(row).toMatchObject({
        totalTokens: 17,
        totalCost: expect.closeTo(0.17, 12),
        messageCounts: { assistant: 4, total: 4 },
        dailyBreakdown: [
          { date: "2026-09-18", tokens: 5 },
          { date: "2026-09-19", tokens: 12 },
        ],
        modelUsage: [
          { provider: "p", model: "b", count: 2, totals: { totalTokens: 12 } },
          { provider: "p", model: "a", count: 2, totals: { totalTokens: 5 } },
        ],
        firstActivity: Date.parse("2026-09-18T18:14:00Z"),
        lastActivity: Date.parse("2026-09-19T01:00:00Z"),
      });
      // Hours are report-local: 23:44 and 23:50, 00:10, then 06:30 IST.
      expect([23, 0, 6].map((hour) => row.localHours?.values[hour])).toEqual([5, 5, 7]);
      expect(row).not.toHaveProperty("utcQuarterHourTokenUsage");

      const nepal = overviewRows(
        await loadSessionUsageOverviewFromCache({
          ...kolkata,
          startMs: Date.parse("2026-09-18T00:00:00+05:45"),
          endMs: Date.parse("2026-09-20T00:00:00+05:45") - 1,
          dayBucket: { mode: "time-zone", timeZone: "Asia/Kathmandu" },
        }),
      );
      expect(nepal.rows[0]?.dailyBreakdown).toMatchObject([
        { date: "2026-09-18", tokens: 2 },
        { date: "2026-09-19", tokens: 15 },
      ]);
      const summary = await loadCostUsageSummaryFromCache({
        agentId,
        requestRefresh: false,
        startMs: Date.parse("2026-10-31T00:00:00-04:00"),
        endMs: Date.parse("2026-11-03T00:00:00-05:00") - 1,
        dayBucket: { mode: "time-zone", timeZone: "America/New_York" },
      });
      expect(summary).toMatchObject({
        cacheStatus: { status: "fresh" },
        totals: { totalTokens: 1111 },
        daily: [
          { date: "2026-10-31", totalTokens: 1 },
          { date: "2026-11-01", totalTokens: 110 },
          { date: "2026-11-02", totalTokens: 1000 },
        ],
      });
      const reads = await probe.read();
      expect(reads.filter(({ kind }) => kind === "transcript" || kind === "decompress")).toEqual(
        [],
      );

      // A sub-quarter overview edge needs transcript details; detail reads still replay them.
      await probe.clear();
      const edge = { startMs: Date.parse("2026-09-18T18:17:00Z") };
      // The family keeps its other instance and stays marked as computing.
      expect(
        overviewRows(await loadSessionUsageOverviewFromCache({ ...kolkata, ...edge })),
      ).toMatchObject({
        rows: [{ totalTokens: 7 }],
        computing: [true],
        cacheStatus: {
          status: "partial",
          partial: { reason: "aggregate-boundary", message: expect.stringContaining("exact") },
        },
      });
      expect((await probe.read()).some(({ kind }) => kind === "transcript")).toBe(false);
      expect(
        await loadSessionCostSummariesFromCache({
          ...kolkata,
          ...edge,
          sessions: [{ sessionFile: first }],
          requestRefresh: false,
        }),
      ).toMatchObject({ summaries: [{ totalTokens: 8 }] });
      expect((await probe.read()).some(({ kind }) => kind === "transcript")).toBe(true);
    });
  });
});
