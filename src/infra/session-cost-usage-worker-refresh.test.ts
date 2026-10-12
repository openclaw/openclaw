import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { createNativeStorageUsageAccess } from "./session-cost-usage-collection.test-support.js";
import {
  decodeUsageCostRollup,
  encodeUsageCostRollup,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";

const timestamp = Date.parse("2026-09-23T12:00:00.000Z");
type Row = { seq: number; event: Record<string, unknown> };
function message(id: string, parentId: string | null, tokens: number): Row["event"] {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: tokens } },
    },
  };
}
const initial: Row[] = [
  { seq: 1, event: message("root", null, 1) },
  { seq: 4, event: message("a", "root", 2) },
];
async function scan(rows: Row[], previous?: UsageCostRollupEntry) {
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
    // A short page does not mean end-of-range; decoded byte limits can cut any page.
    readRows: async (_marker, afterSeq, throughSeq) =>
      rows.filter((row) => row.seq > afterSeq && row.seq <= throughSeq).slice(0, 2),
    access: {
      ...createNativeStorageUsageAccess(),
      readSqliteStats: async () => [
        { maxSeq, eventCount: rows.length, sizeBytes, lastMutationAtMs: timestamp },
      ],
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

describe("mirrored prompt rows", () => {
  function prompt(id: string, parentId: string | null, turn: string, idempotencyKey?: string) {
    return {
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "user",
        content: "synthetic prompt",
        ...(idempotencyKey ? { idempotencyKey } : {}),
        __openclaw: {
          mirrorIdentity: `${turn}:prompt`,
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: "synthetic-fingerprint",
        },
      },
    };
  }
  const admitted = { seq: 1, event: prompt("admitted", null, "turn-1") };
  const mirrored = {
    seq: 2,
    event: prompt("mirrored", "admitted", "turn-1", "codex-app-server:thread:turn-1:prompt"),
  };
  const answer = { seq: 3, event: message("answer", "mirrored", 3) };
  const userMessages = (entry: UsageCostRollupEntry) =>
    Object.values(entry.rollup.buckets).reduce(
      (total, bucket) => total + bucket.messageCounts.user,
      entry.rollup.untimestamped.messageCounts.user,
    );

  it("counts a prompt and its re-mirrored copy once", async () => {
    expect(userMessages(await scan([admitted, mirrored, answer]))).toBe(1);
  });

  it("counts the pair once when a cached refresh ends between its rows", async () => {
    const first = await scan([admitted]);
    const encoded = encodeUsageCostRollup(first);
    const cached = decodeUsageCostRollup(encoded.valueJson, first.pricingFingerprint, encoded.blob);
    expect(userMessages(await scan([admitted, mirrored, answer], cached))).toBe(1);
  });

  it("counts repeated prompt text from separate turns", async () => {
    const result = await scan([
      admitted,
      { seq: 2, event: message("first-answer", "admitted", 3) },
      { seq: 3, event: prompt("again", "first-answer", "turn-2") },
      { seq: 4, event: message("second-answer", "again", 3) },
    ]);
    expect(userMessages(result)).toBe(2);
  });
});
