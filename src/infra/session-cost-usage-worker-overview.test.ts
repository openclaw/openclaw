import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { encodeSessionArchiveContent } from "../config/sessions/archive-compression.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { observeUsageWorkerReads } from "./session-cost-usage-worker-io.test-support.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";

it("keeps overview reads on committed aggregates and preserves exact transcript details", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-overview-boundaries";
    const sessionFile = state.path("usage-overview.jsonl");
    const records = [
      { timestamp: "2026-09-18T23:58:00Z", tokens: 2 },
      { timestamp: "2026-09-18T23:59:00Z", tokens: 3 },
    ].map(({ timestamp, tokens }) =>
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: tokens } },
        },
      }),
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
    await probe.run(async () => {
      await expect(
        loadSessionCostSummariesFromCache({ ...request, committedOnly: true }),
      ).resolves.toMatchObject({
        summaries: [{ totalTokens: 5 }],
        cacheStatus: { status: "fresh" },
      });
      for (const boundary of [
        { startMs: Date.UTC(2026, 8, 18, 23, 59), totalTokens: 3 },
        { dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 1 }, totalTokens: 5 },
      ]) {
        const { totalTokens, ...range } = boundary;
        await probe.clear();
        await expect(
          loadSessionCostSummariesFromCache({ ...request, ...range, committedOnly: true }),
        ).resolves.toMatchObject({
          summaries: [null],
          cacheStatus: {
            status: "partial",
            staleFiles: 0,
            pendingFiles: 1,
            partial: {
              reason: "aggregate-boundary",
              message: expect.stringContaining("exact usage"),
            },
          },
        });
        expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
        await expect(
          loadSessionCostSummariesFromCache({ ...request, ...range }),
        ).resolves.toMatchObject({
          summaries: [{ totalTokens }],
          cacheStatus: { status: "fresh" },
        });
        expect((await probe.read()).some((entry) => entry.kind === "transcript")).toBe(true);
      }
      if (archive.suffix) {
        await probe.clear();
        const work = new AsyncWorkScope();
        try {
          await expect(
            work.track(() =>
              loadSessionCostSummariesFromCache({
                ...request,
                sessions: [{ sessionFile }, { sessionFile: archiveFile }],
                committedOnly: true,
                requestRefresh: true,
              }),
            ),
          ).resolves.toMatchObject({
            summaries: [{ totalTokens: 5 }, null],
            cacheStatus: {
              status: "partial",
              staleFiles: 0,
              pendingFiles: 1,
              partial: { reason: "aggregate-boundary" },
            },
          });
          await work.runWhenIdle(() => undefined);
        } finally {
          await work.drain();
        }
        expect((await probe.read()).filter((entry) => entry.kind === "transcript")).toEqual([]);
      }
    });
  });
});
