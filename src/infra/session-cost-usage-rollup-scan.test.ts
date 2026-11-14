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
  // Isolate decoded expansion from the already resident immutable input. Run the
  // opt-in 640 MiB scan with a 512 MiB heap after preparing the test compiler cache.
  const heapProof = process.env.OPENCLAW_USAGE_HEAP_PROOF === "1";
  const count = heapProof ? 640 : 8;
  const event = message(7);
  const eventJson = JSON.stringify({
    ...event,
    message: {
      ...event.message,
      content: [
        { type: "text", text: "🌞".repeat(heapProof ? 256 * 1024 : 16) },
        ...event.message.content,
      ],
    },
  });
  const result = await scan(Array<string>(count).fill(eventJson));
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
});

it("preserves rewind, side append and parentless navigation with canonical byte anchors", async () => {
  const events = [
    message(3, { id: "a", parentId: null }),
    message(5, { id: "b", parentId: "a" }),
    message(100, { id: "side", parentId: "a", appendMode: "side" }),
    { type: "leaf", id: "rewind", parentId: "side", targetId: "a" },
    message(7, { id: "c" }),
  ];
  // The last raw event is outside the visible branch, but still owns the byte anchor.
  const tail = message(200, { id: "hidden", parentId: "c", appendMode: "side" });
  const json = [...events, tail].map((event) => JSON.stringify(event, null, 2));
  const result = await scan(json);
  expect(result.parsedRecords).toBe(2);
  expect(Object.values(result.rollup.buckets)[0]!.totals).toMatchObject({
    input: 10,
    output: 4,
    totalCost: 2,
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
