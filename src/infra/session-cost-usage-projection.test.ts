import { describe, expect, it } from "vitest";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  projectCostUsageSummary,
  projectSessionCostSummaries,
  type UsageCostRollupRowSource,
} from "./session-cost-usage-projection.js";
import {
  USAGE_COST_ROLLUP_VERSION,
  encodeUsageCostRollup,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "./session-cost-usage-totals.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

const pricingFingerprint = "synthetic-pricing";
const dayStart = Date.UTC(2026, 8, 18);
const utcDayBucket = { mode: "utc-offset", utcOffsetMinutes: 0 } as const;

function createFile(name: string): UsageCostTranscriptFile {
  return {
    filePath: `/synthetic/${name}.jsonl`,
    sourcePath: `/synthetic/${name}.jsonl.gz`,
    kind: "jsonl",
    size: 100,
    mtimeMs: 1_000,
    device: 1,
    inode: 2,
  };
}

function createRow(
  file: UsageCostTranscriptFile,
  contributions: Array<{ timestamp?: number; cost: number }>,
  scannedAt = 100,
  version = USAGE_COST_ROLLUP_VERSION,
): SessionCostUsageRollupRow & { blob: Uint8Array } {
  const rollup = createSessionUsageRollupData();
  for (const contribution of contributions) {
    appendSessionUsageRollupContribution(rollup, {
      timestamp: contribution.timestamp,
      role: "assistant",
      toolNames: [],
      toolResultCounts: { total: 0, errors: 0 },
      usageTotals: {
        ...createEmptyCostUsageTotals(),
        input: 1,
        totalTokens: 1,
        inputCost: contribution.cost,
        totalCost: contribution.cost,
      },
    });
  }
  const entry: UsageCostRollupEntry = {
    version,
    pricingFingerprint,
    checkpoint: {
      kind: "jsonl",
      parsedOffset: file.size,
      observedSize: file.size,
      observedMtimeMs: file.mtimeMs,
      device: file.device ?? 0,
      inode: file.inode ?? 0,
      anchorHash: "synthetic-anchor",
    },
    scannedAt,
    parsedRecords: contributions.length,
    countedRecords: contributions.filter((contribution) => contribution.timestamp !== undefined)
      .length,
    rollup,
  };
  return { key: file.filePath, ...encodeUsageCostRollup(entry), updatedAt: scannedAt + 10_000 };
}

function createSource(
  rows: Array<SessionCostUsageRollupRow & { blob?: Uint8Array }>,
  files: ReadonlyArray<UsageCostTranscriptFile | undefined>,
): UsageCostRollupRowSource {
  const byPath = new Map(rows.map((row) => [row.key, row]));
  const requestedPaths = new Set(files.flatMap((file) => (file ? [file.filePath] : [])));
  return {
    readRow: (filePath) => byPath.get(filePath),
    readBody: (row) => byPath.get(row.key)?.blob ?? null,
    onInvalidBody: () => {},
    remainingRows: rows.filter((row) => !requestedPaths.has(row.key)),
  };
}

describe("usage cache projections", () => {
  it("requests a refresh for rollups computed before pricing availability was preserved", async () => {
    const file = createFile("old-pricing");
    const rows = [createRow(file, [{ timestamp: dayStart, cost: 0 }], 100, 5)];
    const result = await projectSessionCostSummaries({
      ...createSource(rows, [file]),
      sessions: [{ sessionId: "old-pricing", sessionFile: file.filePath }],
      files: [file],
      pricingFingerprint,
      dayBucket: utcDayBucket,
      refreshing: false,
    });
    expect(result.summaries).toEqual([null]);
    expect(result.staleSessionFiles).toEqual([file.sourcePath]);
    expect(result.cacheStatus.cachedFiles).toBe(0);
  });

  it("preserves file-major and timestamp-major addition, including duplicate files", async () => {
    const largeFile = createFile("large");
    const smallFile = createFile("small");
    const orphanFile = createFile("orphan");
    const files = [largeFile, smallFile, smallFile];
    const rows = [
      createRow(smallFile, [
        { timestamp: dayStart + 1, cost: 1 },
        { timestamp: dayStart + 2, cost: 1 },
      ]),
      createRow(orphanFile, [{ timestamp: dayStart, cost: 999 }], 900),
      createRow(largeFile, [
        { timestamp: dayStart + 3, cost: 1 },
        { timestamp: dayStart, cost: 1e16 },
      ]),
      { key: "broken-orphan", valueJson: "{", updatedAt: 99_999 },
    ];
    const result = await projectCostUsageSummary({
      ...createSource(rows, files),
      files,
      pricingFingerprint,
      startMs: dayStart,
      endMs: dayStart + 3,
      dayBucket: utcDayBucket,
      refreshing: false,
    });

    // Each cost-1 addition rounds away; grouping a pair would instead add 2.
    expect(result.totals).toMatchObject({ totalTokens: 6, totalCost: 1e16, inputCost: 1e16 });
    expect(result.daily).toMatchObject([
      { date: "2026-09-18", totalTokens: 6, totalCost: 1e16, inputCost: 1e16 },
    ]);
    expect(result.cacheStatus).toEqual({
      status: "fresh",
      cachedFiles: 3,
      pendingFiles: 0,
      staleFiles: 0,
      refreshedAt: 900,
    });
  });

  it("keeps fractional boundary costs and zero-filled calendar days without unrelated history", async () => {
    const file = createFile("fractional");
    const startMs = dayStart + 12 * 60 * 60 * 1_000;
    const endMs = Date.UTC(2026, 8, 21, 11, 59, 59, 999);
    const rows = [
      createRow(file, [
        { timestamp: endMs, cost: 0.2 },
        { timestamp: endMs + 1, cost: 1_000 },
        { timestamp: startMs - 1, cost: 100 },
        { timestamp: startMs, cost: 0.1 },
        { cost: 500 },
      ]),
    ];
    const result = await projectCostUsageSummary({
      ...createSource(rows, [file]),
      files: [file],
      pricingFingerprint,
      startMs,
      endMs,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 12 * 60 },
      refreshing: false,
    });

    expect(result.days).toBe(3);
    expect(result.totals).toMatchObject({ totalTokens: 2, totalCost: 0.30000000000000004 });
    expect(result.daily).toMatchObject([
      { date: "2026-09-19", totalTokens: 1, totalCost: 0.1 },
      { date: "2026-09-20", totalTokens: 0, totalCost: 0 },
      { date: "2026-09-21", totalTokens: 1, totalCost: 0.2 },
    ]);
  });

  it("keeps committed totals and freshness for duplicate canonical files", async () => {
    const file = createFile("selected");
    const rows = [createRow(file, [{ timestamp: dayStart, cost: 0.5 }, { cost: 0.25 }], 300)];
    const sessions = [
      { sessionId: "first", sessionFile: "first-archive-alias" },
      { sessionId: "stale", sessionFile: "stale-archive-alias" },
      { sessionId: "second", sessionFile: "second-archive-alias" },
      { sessionId: "missing", sessionFile: "missing-transcript" },
      { sessionId: "missing-again", sessionFile: "missing-transcript" },
    ];
    const files = [file, { ...file, size: file.size + 1 }, file, undefined, undefined];
    for (const [range, expectedCost] of [
      [{}, 0.75],
      [{ startMs: dayStart, endMs: dayStart }, 0.5],
      [{ startMs: dayStart + 1, endMs: dayStart + 1 }, 0],
    ] as const) {
      const result = await projectSessionCostSummaries({
        ...createSource(rows, files),
        ...range,
        sessions,
        files,
        pricingFingerprint,
        dayBucket: utcDayBucket,
        refreshing: true,
      });

      expect(result.summaries).toMatchObject([
        { sessionId: "first", sessionFile: "first-archive-alias", totalCost: expectedCost },
        {
          sessionId: "stale",
          totalCost: expectedCost,
          computedAt: 300,
          refreshing: true,
          staleSince: file.mtimeMs,
        },
        { sessionId: "second", sessionFile: "second-archive-alias", totalCost: expectedCost },
        null,
        null,
      ]);
      expect(result.summaries[0]).not.toBe(result.summaries[2]);
      expect(result.summaries[0]?.dailyBreakdown).not.toBe(result.summaries[2]?.dailyBreakdown);
      expect(result.staleSessionFiles).toEqual([file.sourcePath, "missing-transcript"]);
      expect(result.cacheStatus).toEqual({
        status: "refreshing",
        cachedFiles: 3,
        pendingFiles: 2,
        staleFiles: 2,
        refreshedAt: 300,
      });
    }
    const fresh = await projectSessionCostSummaries({
      ...createSource(rows, [file]),
      sessions: [{ sessionFile: "fresh-archive-alias" }],
      files: [file],
      pricingFingerprint,
      dayBucket: utcDayBucket,
      refreshing: true,
    });
    expect(fresh.cacheStatus.status).toBe("fresh");
  });
});
