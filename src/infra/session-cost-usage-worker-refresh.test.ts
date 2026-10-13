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
const initial: Row[] = [
  { seq: 1, event: message("root", null, 1) },
  { seq: 4, event: message("a", "root", 2) },
];
async function scan(
  rows: Row[],
  previous?: UsageCostRollupEntry,
  generation = "initial",
  readSequences?: number[],
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
  it("keeps known billing separate from unavailable usage across incremental refreshes", async () => {
    const before = await scan(initial);
    const interrupted = [...initial, { seq: 9, event: message("aborted", "a", 100, true) }];
    const afterAbort = await scan(interrupted, before);
    expect(afterAbort.rollup.buckets[String(timestamp)]?.totals).toMatchObject({
      usageReport: { state: "unavailable" },
      totalTokens: 3,
      totalCost: 3,
      missingCostEntries: 1,
    });

    const afterSuccess = await scan(
      [...interrupted, { seq: 12, event: message("completed", "aborted", 4) }],
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
      { seq: 1, event: message("root", null, 1) },
      { seq: 4, event: message("hidden", "root", 100) },
      { seq: 5, event: message("hidden-tail", "hidden", 100) },
      { seq: 8, event: { type: "leaf", id: "switch", parentId: "hidden-tail", targetId: "root" } },
      { seq: 13, event: message("chosen", "switch", 2) },
      { seq: 20, event: message("chosen-tail", "chosen", 3) },
    ]);
    expectUsage(result, 6, 3, "chosen-tail");
    expect(result.checkpoint).toMatchObject({ maxSeq: 20, eventCount: 6 });
  });

  it.each([
    {
      kind: "append",
      suffix: [{ seq: 16, event: message("d", "c", 16) }],
      tokens: 31,
      records: 5,
      leaf: "d",
    },
    {
      kind: "leaf",
      suffix: [{ seq: 20, event: { type: "leaf", id: "switch", parentId: "c", targetId: "root" } }],
      tokens: 1,
      records: 1,
      leaf: "root",
    },
    {
      kind: "reset",
      suffix: [
        { seq: 20, event: { type: "reset", id: "reset", parentId: null } },
        { seq: 25, event: message("after-reset", "root", 16) },
      ],
      tokens: 16,
      records: 1,
      leaf: "after-reset",
    },
  ])(
    "preserves the selected rollup through later $kind pages",
    async ({ suffix, tokens, records, leaf }) => {
      const previous = await scan(initial);
      const result = await scan(
        [
          ...initial,
          { seq: 9, event: message("b", "a", 4) },
          { seq: 12, event: message("c", "b", 8) },
          ...suffix,
        ],
        previous,
      );
      expectUsage(result, tokens, records, leaf);
    },
  );

  it("reads only appended rows once while retaining the full-scan totals", async () => {
    const previous = await scan(initial);
    const rows = [...initial, { seq: 9, event: message("b", "a", 4) }];
    const readSequences: number[] = [];
    const incremental = await scan(rows, previous, "initial", readSequences);
    expectUsage(incremental, 7, 3, "b");
    expect(readSequences).toEqual([9]);
    expect(incremental.rollup).toEqual((await scan(rows)).rollup);
  });

  it.each([
    {
      change: "rewrite an earlier row then append",
      generation: "rewritten",
      rows: [
        { seq: 1, event: message("root", null, 8) },
        initial[1]!,
        { seq: 9, event: message("b", "a", 4) },
      ],
      tokens: 14,
      records: 3,
      leaf: "b",
    },
    {
      change: "rewind",
      generation: "rewound",
      rows: [initial[0]!],
      tokens: 1,
      records: 1,
      leaf: "root",
    },
    {
      change: "compact",
      generation: "compacted",
      rows: [
        { seq: 1, event: { type: "compaction", id: "compact", parentId: null } },
        { seq: 4, event: message("a", "compact", 2) },
        { seq: 9, event: message("b", "a", 4) },
      ],
      tokens: 6,
      records: 2,
      leaf: "b",
    },
  ])(
    "rebuilds after $change without counting retired usage",
    async ({ generation, rows, tokens, records, leaf }) => {
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
      { seq: 4, event: { type: "leaf", id: "switch", parentId: "user", targetId: "answer" } },
    ]);
    expectUsage(result, 3, 1, "answer");
    expect(result.rollup.lastUserTimestamp).toBe(timestamp + 1000);
    expect(
      Object.values(result.rollup.buckets).find((bucket) => bucket.latency.count > 0)?.latency,
    ).toMatchObject({ count: 1, min: 1000, max: 1000, sum: 1000 });
  });
});
