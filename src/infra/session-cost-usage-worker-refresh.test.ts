import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { UsageCostRollupEntry } from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";

const timestamp = Date.parse("2026-09-23T12:00:00.000Z");
type Row = { seq: number; event: Record<string, unknown> };
function message(
  id: string,
  parentId: string | null,
  tokens: number,
  incomplete = false,
): Row["event"] {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      usage: {
        input: tokens,
        output: 0,
        totalTokens: tokens,
        cost: { total: tokens },
        ...(incomplete ? { usageReport: { state: "unavailable" } } : {}),
      },
    },
  };
}
const makeRow = (
  seq: number,
  id: string,
  parent: string | null,
  tokens: number,
  incomplete = false,
): Row => ({ seq, event: message(id, parent, tokens, incomplete) });
const control = (
  seq: number,
  type: string,
  id: string,
  parentId: string | null,
  targetId?: string,
): Row => ({ seq, event: { type, id, parentId, ...(targetId ? { targetId } : {}) } });
const initial = [makeRow(1, "root", null, 1), makeRow(4, "a", "root", 2)];
async function scan(
  rows: Row[],
  previous?: UsageCostRollupEntry,
  generation = "initial",
  readSequences?: number[],
  checkProgress?: () => void,
) {
  const storePath = path.resolve("synthetic-usage-paging.sqlite");
  const filePath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId: "paging",
    storePath,
  });
  const maxSeq = rows.at(-1)?.seq ?? 0;
  const sizeBytes = rows.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.event)) + 1,
    0,
  );
  return scanUsageCostRollupInWorker({
    file: {
      kind: "sqlite",
      filePath,
      sourcePath: filePath,
      sessionId: "paging",
      maxSeq,
      eventCount: rows.length,
      size: sizeBytes,
      mtimeMs: timestamp,
    },
    previous,
    pricingFingerprint: "synthetic-pricing",
    resolveCosts: async (pairs) => pairs.map(() => undefined),
    readGeneration: async () => generation,
    checkProgress,
    // A short page does not mean end-of-range; decoded byte limits can cut any page.
    readRows: async (_marker, afterSeq, throughSeq) => {
      const page = rows.filter((row) => row.seq > afterSeq && row.seq <= throughSeq).slice(0, 2);
      readSequences?.push(...page.map((row) => row.seq));
      return page;
    },
  });
}
function expectUsage(entry: UsageCostRollupEntry, tokens: number, records: number, leaf: string) {
  expect(entry.parsedRecords).toBe(records);
  expect(entry.countedRecords).toBe(records);
  expect(
    Object.values(entry.rollup.buckets).reduce(
      (total, bucket) => total + bucket.totals.totalTokens,
      0,
    ),
  ).toBe(tokens);
  expect(entry.checkpoint).toMatchObject({ kind: "sqlite", visibleLeafId: leaf });
}

describe("paged SQLite usage rollups", () => {
  it("stops reading subsequent transcript pages when its owner cancels", async () => {
    const controller = new AbortController();
    const reason = new Error("usage client disconnected");
    const readSequences: number[] = [];
    await expect(
      scan([...initial, makeRow(9, "b", "a", 4)], undefined, "initial", readSequences, () => {
        if (readSequences.length > 0) {
          controller.abort(reason);
        }
        controller.signal.throwIfAborted();
      }),
    ).rejects.toBe(reason);
    expect(readSequences).toEqual([1, 4]);
  });

  it("keeps known billing separate from unavailable usage across incremental refreshes", async () => {
    const before = await scan(initial);
    const interrupted = [...initial, makeRow(9, "aborted", "a", 100, true)];
    const afterAbort = await scan(interrupted, before);
    expect(afterAbort.rollup.buckets[String(timestamp)]?.totals).toMatchObject({
      usageReport: { state: "unavailable" },
      totalTokens: 3,
      totalCost: 3,
      missingCostEntries: 1,
    });

    const afterSuccess = await scan(
      [...interrupted, makeRow(12, "completed", "aborted", 4)],
      afterAbort,
    );
    expect(afterSuccess.rollup.buckets[String(timestamp)]?.totals).toMatchObject({
      usageReport: { state: "unavailable" },
      totalTokens: 7,
      totalCost: 7,
      missingCostEntries: 1,
    });
  });

  it("selects a branch after reading all short pages and preserves sparse sequence numbers", async () => {
    const result = await scan([
      makeRow(1, "root", null, 1),
      makeRow(4, "hidden", "root", 100),
      makeRow(5, "hidden-tail", "hidden", 100),
      control(8, "leaf", "switch", "hidden-tail", "root"),
      makeRow(13, "chosen", "switch", 2),
      makeRow(20, "chosen-tail", "chosen", 3),
    ]);
    expectUsage(result, 6, 3, "chosen-tail");
    expect(result.checkpoint).toMatchObject({ maxSeq: 20, eventCount: 6 });
  });

  it.each<[string, Row[], number, number, string]>([
    ["append", [makeRow(16, "d", "c", 16)], 31, 5, "d"],
    ["leaf", [control(20, "leaf", "switch", "c", "root")], 1, 1, "root"],
    [
      "reset",
      [control(20, "reset", "reset", null), makeRow(25, "after-reset", "root", 16)],
      16,
      1,
      "after-reset",
    ],
  ])(
    "preserves the selected rollup through later %s pages",
    async (_kind, suffix, tokens, records, leaf) => {
      const previous = await scan(initial);
      const result = await scan(
        [...initial, makeRow(9, "b", "a", 4), makeRow(12, "c", "b", 8), ...suffix],
        previous,
      );
      expectUsage(result, tokens, records, leaf);
    },
  );

  it("reads only appended rows once while retaining the full-scan totals", async () => {
    const previous = await scan(initial);
    const rows = [...initial, makeRow(9, "b", "a", 4)];
    const readSequences: number[] = [];
    const incremental = await scan(rows, previous, "initial", readSequences);
    expectUsage(incremental, 7, 3, "b");
    expect(readSequences).toEqual([9]);
    expect(incremental.rollup).toEqual((await scan(rows)).rollup);
  });

  it.each<[string, string, Row[], number, number, string]>([
    [
      "rewrite an earlier row then append",
      "rewritten",
      [makeRow(1, "root", null, 8), initial[1]!, makeRow(9, "b", "a", 4)],
      14,
      3,
      "b",
    ],
    ["rewind", "rewound", [initial[0]!], 1, 1, "root"],
    [
      "compact",
      "compacted",
      [
        control(1, "compaction", "compact", null),
        makeRow(4, "a", "compact", 2),
        makeRow(9, "b", "a", 4),
      ],
      6,
      2,
      "b",
    ],
  ])(
    "rebuilds after %s without counting retired usage",
    async (_change, generation, rows, tokens, records, leaf) => {
      const previous = await scan(initial);
      const readSequences: number[] = [];
      const rebuilt = await scan(rows, previous, generation, readSequences);
      expectUsage(rebuilt, tokens, records, leaf);
      expect(rebuilt.rollup).toEqual((await scan(rows, undefined, generation)).rollup);
      expect(readSequences).toEqual(rows.map((row) => row.seq));
    },
  );

  it("aggregates duplicate-ID paths in selected ancestry order when sequence numbers go backward", async () => {
    const user = (at: number) => ({
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(at).toISOString(),
      message: { role: "user", content: "synthetic" },
    });
    const result = await scan([
      { seq: 1, event: user(timestamp) },
      {
        seq: 2,
        event: {
          ...message("answer", "user", 3),
          timestamp: new Date(timestamp + 2000).toISOString(),
        },
      },
      { seq: 3, event: user(timestamp + 1000) },
      control(4, "leaf", "switch", "user", "answer"),
    ]);
    expectUsage(result, 3, 1, "answer");
    expect(result.rollup.lastUserTimestamp).toBe(timestamp + 1000);
    expect(
      Object.values(result.rollup.buckets).find((bucket) => bucket.latency.count > 0)?.latency,
    ).toMatchObject({ count: 1, min: 1000, max: 1000, sum: 1000 });
  });
});
