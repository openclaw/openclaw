import { describe, expect, it } from "vitest";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  projectCostUsageSummary,
  projectSessionCostSummaries,
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
const fileStats = { kind: "jsonl", size: 100, mtimeMs: 1_000, device: 1, inode: 2 } as const;
const createFile = (name: string): UsageCostTranscriptFile => ({
  ...fileStats,
  filePath: `/synthetic/${name}.jsonl`,
  sourcePath: `/synthetic/${name}.jsonl.gz`,
});

function createRow(
  file: UsageCostTranscriptFile,
  scannedAt: number,
  ...contributions: Array<[offsetMs: number | undefined, cost: number]>
): SessionCostUsageRollupRow & { blob: Uint8Array } {
  const rollup = createSessionUsageRollupData();
  for (const [offsetMs, cost] of contributions) {
    appendSessionUsageRollupContribution(rollup, {
      timestamp: offsetMs === undefined ? undefined : dayStart + offsetMs,
      role: "assistant",
      toolNames: [],
      toolResultCounts: { total: 0, errors: 0 },
      usageTotals: {
        ...createEmptyCostUsageTotals(),
        input: 1,
        totalTokens: 1,
        inputCost: cost,
        totalCost: cost,
      },
    });
  }
  const entry: UsageCostRollupEntry = {
    version: USAGE_COST_ROLLUP_VERSION,
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
    countedRecords: contributions.filter(([timestamp]) => timestamp !== undefined).length,
    rollup,
  };
  return { key: file.filePath, ...encodeUsageCostRollup(entry), updatedAt: scannedAt + 10_000 };
}

function createSource<File extends UsageCostTranscriptFile | undefined>(
  rows: Array<SessionCostUsageRollupRow & { blob?: Uint8Array }>,
  files: readonly File[],
) {
  return {
    files,
    pricingFingerprint,
    dayBucket: utcDayBucket,
    readRow: (filePath: string) => rows.find((row) => row.key === filePath),
    readBody: ({ key }: SessionCostUsageRollupRow) =>
      rows.find((row) => row.key === key)?.blob ?? null,
    onInvalidBody: () => {},
    remainingRows: rows.filter((row) => !files.some((file) => file?.filePath === row.key)),
  };
}

const cacheStatus = (status: string, counts: [number, number, number], refreshedAt?: number) => ({
  status,
  cachedFiles: counts[0],
  pendingFiles: counts[1],
  staleFiles: counts[2],
  ...(refreshedAt === undefined ? {} : { refreshedAt }),
});

describe("usage cache projections", () => {
  it("repairs missing bodies despite partition budget deferral", async () => {
    const file = createFile("corrupt-deferred");
    const row = createRow(file, 100, [0, 1]);
    const invalid: string[] = [];
    const result = await projectSessionCostSummaries({
      ...createSource([{ ...row, bodyBytes: 0 }], [file]),
      deferredPaths: new Set([row.key]),
      onInvalidBody: (key) => invalid.push(key),
      sessions: [{ sessionFile: file.filePath }],
    });
    expect(result).toMatchObject({
      summaries: [null],
      staleSessionFiles: [file.sourcePath],
      cacheStatus: { staleFiles: 1 },
    });
    expect(invalid).toEqual([row.key]);
  });

  it.each([false, true])(
    "refreshes a budget-deferred aggregate only when stale=%s",
    async (stale) => {
      const file = createFile("deferred");
      const row = createRow(file, 100, [0, 1]);
      const result = await projectCostUsageSummary({
        ...createSource([row], [file]),
        startMs: dayStart,
        endMs: dayStart + 86_400_000 - 1,
        readEntry: async () => null,
        files: [stale ? { ...file, size: file.size + 1, mtimeMs: file.mtimeMs + 1 } : file],
      });
      expect(result.cacheStatus).toMatchObject(
        cacheStatus(stale ? "stale" : "partial", [0, 1, stale ? 1 : 0]),
      );
      expect(result.totals.totalTokens).toBe(0);
    },
  );

  it("preserves file-major and timestamp-major addition, including duplicate files", async () => {
    const largeFile = createFile("large");
    const smallFile = createFile("small");
    const orphanFile = createFile("orphan");
    const files = [largeFile, smallFile, smallFile];
    const rows = [
      createRow(smallFile, 100, [1, 1], [2, 1]),
      createRow(orphanFile, 900, [0, 999]),
      createRow(largeFile, 100, [3, 1], [0, 1e16]),
      { key: "broken-orphan", valueJson: "{", updatedAt: 99_999 },
    ];
    const result = await projectCostUsageSummary({
      ...createSource(rows, files),
      startMs: dayStart,
      endMs: dayStart + 3,
    });

    // Each cost-1 addition rounds away; grouping a pair would instead add 2.
    expect(result.totals).toMatchObject({ totalTokens: 6, totalCost: 1e16, inputCost: 1e16 });
    expect(result.daily).toMatchObject([
      { date: "2026-09-18", totalTokens: 6, totalCost: 1e16, inputCost: 1e16 },
    ]);
    expect(result.cacheStatus).toEqual(cacheStatus("fresh", [3, 0, 0], 900));
  });

  it("keeps fractional boundary costs and zero-filled calendar days without unrelated history", async () => {
    const file = createFile("fractional");
    const startMs = dayStart + 12 * 60 * 60 * 1_000;
    const endMs = Date.UTC(2026, 8, 21, 11, 59, 59, 999);
    const rows = [
      createRow(
        file,
        100,
        [endMs - dayStart, 0.2],
        [endMs + 1 - dayStart, 1_000],
        [startMs - 1 - dayStart, 100],
        [startMs - dayStart, 0.1],
        [undefined, 500],
      ),
    ];
    const result = await projectCostUsageSummary({
      ...createSource(rows, [file]),
      startMs,
      endMs,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 12 * 60 },
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
    const rows = [createRow(file, 300, [0, 0.5], [undefined, 0.25])];
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
      });

      expect(result.summaries).toMatchObject([
        { sessionId: "first", sessionFile: "first-archive-alias", totalCost: expectedCost },
        {
          sessionId: "stale",
          totalCost: expectedCost,
          computedAt: 300,
          refreshing: false,
          staleSince: file.mtimeMs,
        },
        { sessionId: "second", sessionFile: "second-archive-alias", totalCost: expectedCost },
        null,
        null,
      ]);
      expect(result.summaries[0]).not.toBe(result.summaries[2]);
      expect(result.summaries[0]?.dailyBreakdown).not.toBe(result.summaries[2]?.dailyBreakdown);
      expect(result.staleSessionFiles).toEqual([file.sourcePath, "missing-transcript"]);
      expect(result.cacheStatus).toEqual(cacheStatus("partial", [3, 2, 2], 300));
    }
  });
});
