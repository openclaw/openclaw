import path from "node:path";
import { expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { UsageCostRollupEntry } from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";

const timestamp = Date.parse("2026-09-23T12:00:00.000Z");
type Row = { seq: number; event: Record<string, unknown> };
function makeRow(
  seq: number,
  id: string,
  parentId: string | null,
  tokens: number,
  incomplete = false,
): Row {
  const usage = {
    input: tokens,
    output: 0,
    totalTokens: tokens,
    cost: { total: tokens },
    ...(incomplete ? { usageReport: { state: "unavailable" } } : {}),
  };
  return {
    seq,
    event: {
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "assistant", usage },
    },
  };
}
const control = (
  seq: number,
  type: string,
  id: string,
  parentId: string | null,
  targetId?: string,
): Row => ({ seq, event: { type, id, parentId, ...(targetId ? { targetId } : {}) } });
const initial = [makeRow(1, "root", null, 1), makeRow(4, "a", "root", 2)];
const appended = [...initial, makeRow(9, "b", "a", 4), makeRow(12, "c", "b", 8)];
async function scan(
  rows: Row[],
  previous?: UsageCostRollupEntry,
  generation = "initial",
  readSequences?: number[],
  checkProgress?: () => void,
) {
  const filePath = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId: "paging",
    storePath: path.resolve("synthetic-usage-paging.sqlite"),
  });
  return scanUsageCostRollupInWorker({
    file: {
      kind: "sqlite",
      filePath,
      sourcePath: filePath,
      sessionId: "paging",
      maxSeq: rows.at(-1)?.seq ?? 0,
      eventCount: rows.length,
      size: rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.event)) + 1, 0),
      mtimeMs: timestamp,
    },
    previous,
    pricingFingerprint: "synthetic-pricing",
    resolveCosts: async (pairs) => pairs.map(() => undefined),
    readGeneration: async () => generation,
    checkProgress,
    // A short page does not mean end-of-range; decoded byte limits can cut any page.
    readRows: async (_marker, afterSeq, throughSeq, consume) => {
      const page = rows.filter((row) => row.seq > afterSeq && row.seq <= throughSeq).slice(0, 2);
      readSequences?.push(...page.map((row) => row.seq));
      page.forEach(({ seq, event }) => consume(seq, event));
      return page.at(-1)?.seq ?? afterSeq;
    },
  });
}
function expectUsage(entry: UsageCostRollupEntry, tokens: number, records: number, leaf: string) {
  expect(entry).toMatchObject({
    parsedRecords: records,
    countedRecords: records,
    checkpoint: { kind: "sqlite", visibleLeafId: leaf },
  });
  expect(
    Object.values(entry.rollup.buckets).reduce((sum, b) => sum + b.totals.totalTokens, 0),
  ).toBe(tokens);
}
function expectIncomplete(entry: UsageCostRollupEntry, total: number) {
  expect(entry.rollup.buckets[String(timestamp)]?.totals).toMatchObject({
    usageReport: { state: "unavailable" },
    totalTokens: total,
    totalCost: total,
    missingCostEntries: 1,
  });
}

it("stops reading subsequent transcript pages when its owner cancels", async () => {
  const reason = new Error("usage client disconnected");
  const readSequences: number[] = [];
  await expect(
    scan([...initial, makeRow(9, "b", "a", 4)], undefined, "initial", readSequences, () => {
      if (readSequences.length > 0) {
        throw reason;
      }
    }),
  ).rejects.toBe(reason);
  expect(readSequences).toEqual([1, 4]);
});

it("keeps known billing separate from unavailable usage across incremental refreshes", async () => {
  const before = await scan(initial);
  const interrupted = [...initial, makeRow(9, "aborted", "a", 100, true)];
  const afterAbort = await scan(interrupted, before);
  expectIncomplete(afterAbort, 3);
  expectIncomplete(
    await scan([...interrupted, makeRow(12, "completed", "aborted", 4)], afterAbort),
    7,
  );
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

it.each<[string, Row[], [number, number, string], string?]>([
  ["append", [...appended, makeRow(16, "d", "c", 16)], [31, 5, "d"]],
  ["leaf", [...appended, control(20, "leaf", "switch", "c", "root")], [1, 1, "root"]],
  [
    "reset",
    [...appended, control(20, "reset", "reset", null), makeRow(25, "after-reset", "root", 16)],
    [16, 1, "after-reset"],
  ],
  ["rewind", [initial[0]!], [1, 1, "root"], "rewound"],
  [
    "compact",
    [control(1, "compaction", "root", null), ...appended.slice(1, 3)],
    [6, 2, "b"],
    "compacted",
  ],
])("preserves selected usage after %s", async (_change, rows, expected, generation = "initial") => {
  const previous = await scan(initial);
  const readSequences: number[] = [];
  const result = await scan(rows, previous, generation, readSequences);
  expectUsage(result, ...expected);
  if (generation !== "initial" || _change === "append") {
    expect(result.rollup).toEqual((await scan(rows, undefined, generation)).rollup);
    expect(readSequences).toEqual(
      generation !== "initial" ? rows.map((row) => row.seq) : [9, 12, 16],
    );
  }
});

it("aggregates duplicate-ID paths in selected ancestry order when sequence numbers go backward", async () => {
  const user = (at: number) => ({
    type: "message",
    id: "user",
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: "synthetic" },
  });
  const answer = makeRow(2, "answer", "user", 3);
  answer.event.timestamp = new Date(timestamp + 2000).toISOString();
  const result = await scan([
    { seq: 1, event: user(timestamp) },
    answer,
    { seq: 3, event: user(timestamp + 1000) },
    control(4, "leaf", "switch", "user", "answer"),
  ]);
  expectUsage(result, 3, 1, "answer");
  expect(result.rollup.lastUserTimestamp).toBe(timestamp + 1000);
  expect(
    Object.values(result.rollup.buckets).find((bucket) => bucket.latency.count > 0)?.latency,
  ).toMatchObject({ count: 1, min: 1000, max: 1000, sum: 1000 });
});
