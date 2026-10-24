import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { encodeSessionArchiveContent } from "../config/sessions/archive-compression.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { createUsageTranscriptEntry } from "./session-cost-usage-fixtures.test-support.js";
import { observeUsageWorkerReads } from "./session-cost-usage-worker-io.test-support.js";
import { loadSessionCostSummariesFromCache as load } from "./session-cost-usage.js";

it("keeps overview reads on committed aggregates and preserves exact transcript details", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-overview-boundaries";
    const sessionFile = state.path("usage-overview.jsonl");
    const records = [
      { timestamp: "2026-09-18T23:58:00Z", tokens: 2 },
      { timestamp: "2026-09-18T23:59:00Z", tokens: 3 },
    ].map(({ timestamp, tokens }) =>
      JSON.stringify(createUsageTranscriptEntry(tokens, { timestamp, cost: tokens })),
    );
    const content = records.join("\n") + "\n";
    await fs.writeFile(sessionFile, content);
    await refreshCostUsageCacheForAgent({ config: {}, agentId, sessionFiles: [sessionFile] });
    const archive = encodeSessionArchiveContent(content);
    const archiveFile = state.path(`archived.jsonl.deleted.overview${archive.suffix}`);
    await fs.writeFile(archiveFile, archive.bytes);
    const probe = await observeUsageWorkerReads(state.stateDir, [sessionFile, archiveFile]);
    const request = {
      agentId,
      sessions: [{ sessionFile }],
      requestRefresh: false,
      startMs: Date.UTC(2026, 8, 18),
      endMs: Date.UTC(2026, 8, 19) - 1,
      dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
    };
    type Query = Partial<Parameters<typeof load>[0]>;
    const fresh = { status: "fresh" };
    const exactUsage = expect.stringContaining("exact usage");
    const partial = {
      status: "partial",
      staleFiles: 0,
      pendingFiles: 1,
      partial: { reason: "aggregate-boundary", message: exactUsage },
    };
    const check = (options: Query, tokens: Array<number | null>, cacheStatus = fresh) =>
      expect(load({ ...request, ...options })).resolves.toMatchObject({
        summaries: tokens.map((totalTokens) => (totalTokens === null ? null : { totalTokens })),
        cacheStatus,
      });
    await probe.run(async () => {
      await check({ committedOnly: true }, [5]);
      for (const boundary of [
        { startMs: Date.UTC(2026, 8, 18, 23, 59), totalTokens: 3 },
        { dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 1 }, totalTokens: 5 },
      ]) {
        const { totalTokens, ...range } = boundary;
        await probe.clear();
        await check({ ...range, committedOnly: true }, [null], partial);
        expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
        await check(range, [totalTokens]);
        expect((await probe.read()).some((entry) => entry.kind === "transcript")).toBe(true);
      }
      if (archive.suffix) {
        await probe.clear();
        const work = new AsyncWorkScope();
        const archived = {
          sessions: [{ sessionFile }, { sessionFile: archiveFile }],
          committedOnly: true,
          requestRefresh: true,
        };
        try {
          await work.track(() => check(archived, [5, null], partial));
        } finally {
          await work.drain();
        }
        expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
      }
    });
  });
});
