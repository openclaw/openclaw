import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { scanMemoryUsageCostRollup } from "./session-cost-usage-rollup-scan.js";

const message = (input: number, fields: Record<string, unknown> = {}) => ({
  type: "message",
  timestamp: "2026-10-18T12:00:00.000Z",
  ...fields,
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
    usage: { input, output: 2, totalTokens: input + 2, cost: { total: 1 } },
  },
});

const scan = (json: string[]) =>
  scanMemoryUsageCostRollup({
    file: {
      kind: "sqlite",
      filePath: "synthetic-memory-transcript",
      sourcePath: "synthetic-memory-transcript",
      sessionId: "memory-scan",
      size: json.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0),
      mtimeMs: 1,
      maxSeq: json.length,
      eventCount: json.length,
    },
    events: json.map((eventJson, index) => ({ seq: index + 1, eventJson })),
    pricingFingerprint: "fixture",
    resolveCosts: async (pairs) => pairs.map(() => undefined),
  });

it("does not retain decoded payloads while refreshing memory usage", async () => {
  // Eight ordinary turns, each row carrying the id and parent link a real
  // appender writes, so every turn is on the billed path. Base reports the same
  // eight turns (72 tokens) for this history.
  const count = 8;
  const rowJson = (index: number, text: string) => {
    const event = message(7, { id: `a${index}`, parentId: index === 0 ? null : `a${index - 1}` });
    return JSON.stringify({
      ...event,
      message: {
        ...event.message,
        content: [{ type: "text", text }, ...event.message.content],
      },
    });
  };
  const result = await scan(
    Array.from({ length: count }, (_row, index) => rowJson(index, "🌞".repeat(16))),
  );
  const bucket = Object.values(result.rollup.buckets)[0]!;
  expect(result.parsedRecords).toBe(count);
  expect(result.countedRecords).toBe(count);
  expect(bucket.totals).toMatchObject({
    input: 7 * count,
    output: 2 * count,
    totalTokens: 9 * count,
    totalCost: count,
  });
  expect(bucket.tools).toEqual([{ name: "read", count }]);
  if (process.env.OPENCLAW_USAGE_HEAP_PROOF !== "1") {
    return;
  }
  // Isolate decoded expansion from the already resident immutable input: run the
  // opt-in 640 MiB scan with a 512 MiB heap after preparing the test compiler
  // cache. One resident 1 MiB payload is parsed 640 times, so retaining any
  // decoded payload exhausts the heap. The copies share one id, so only the one
  // billed row reaches the rollup.
  const shared = rowJson(0, "🌞".repeat(256 * 1024));
  expect((await scan(Array<string>(640).fill(shared))).parsedRecords).toBe(1);
});

it("bills a flat transcript whose rows carry no navigation ids", async () => {
  // An older appender wrote rows without an id, so no path reaches them. With no
  // leaf control the transcript is still one branch and base bills all 8 rows
  // (72 tokens), so the flat fallback must keep doing that.
  const result = await scan(Array<string>(8).fill(JSON.stringify(message(7))));
  expect(result.parsedRecords).toBe(8);
  expect(Object.values(result.rollup.buckets)[0]!.totals).toMatchObject({
    input: 56,
    output: 16,
    totalTokens: 72,
    totalCost: 8,
  });
});

it("preserves rewind, side append and parentless navigation with canonical byte anchors", async () => {
  // The real append path writes a side artifact without a parentId, so it hangs
  // off the leaf that was active when it landed, and a later rewind chains its
  // leaf control onto it. Billing therefore still reaches the displaced tip `b`.
  const events = [
    message(3, { id: "a", parentId: null }),
    message(5, { id: "b", parentId: "a" }),
    {
      type: "custom",
      id: "side",
      customType: "audit",
      appendMode: "side",
      timestamp: "2026-10-18T12:00:00.000Z",
    },
    { type: "leaf", id: "rewind", parentId: "side", targetId: "a" },
    message(7, { id: "c" }),
  ];
  // The last raw event is outside the visible branch, but still owns the byte anchor.
  const tail = message(200, { id: "hidden", parentId: "c", appendMode: "side" });
  const json = [...events, tail].map((event) => JSON.stringify(event, null, 2));
  const result = await scan(json);
  // Base reports 15 tokens for this history (rewind after a side append), so the
  // one in-place transcript bills a, the displaced b and the new c.
  expect(result.parsedRecords).toBe(3);
  expect(Object.values(result.rollup.buckets)[0]!.totals).toMatchObject({
    input: 15,
    output: 6,
    totalCost: 3,
  });
  expect(result.checkpoint).toMatchObject({
    kind: "sqlite",
    maxSeq: 6,
    eventCount: 6,
    visibleLeafId: "c",
    anchorHash: createHash("sha256").update(JSON.stringify(tail)).digest("base64url"),
  });
  const empty = await scan([]);
  expect(empty.parsedRecords).toBe(0);
  expect(empty.checkpoint).toMatchObject({
    maxSeq: 0,
    anchorHash: createHash("sha256").update("").digest("base64url"),
  });
});
