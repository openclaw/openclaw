import { expect, it } from "vitest";
import { createControlUiJournalWriter } from "../../scripts/lib/gateway-bench-control-ui-journal.ts";
import {
  controlUiClockAligned,
  parseControlUiJournal,
} from "../../scripts/lib/gateway-bench-control-ui.ts";

it("batches queued frames and joins backpressure without delaying capture", async () => {
  const first = Promise.withResolvers<void>();
  const writes: string[] = [];
  const errors: unknown[] = [];
  const record = createControlUiJournalWriter(
    async (text) => {
      writes.push(text);
      if (writes.length === 1) {
        await first.promise;
      }
    },
    (error) => {
      errors.push(error);
    },
  );
  const flush = record("first\n");
  void record("second\n");
  expect(record("third\n")).toBe(flush);
  expect(writes).toEqual(["first\n"]);
  first.resolve();
  await flush;
  expect(writes).toEqual(["first\n", "second\nthird\n"]);
  await record("last\n");
  expect(writes.at(-1)).toBe("last\n");
  expect(errors).toEqual([]);
});

it("retains an injected journal failure without hanging finalization", async () => {
  const failure = new Error("synthetic write failure");
  const errors: unknown[] = [];
  const record = createControlUiJournalWriter(
    async () => {
      throw failure;
    },
    (error) => {
      errors.push(error);
    },
  );
  await record("frame\n");
  expect(errors).toEqual([failure]);
});

it("rejects delayed starts and shifted CPU windows using recorded clock offsets", () => {
  expect(controlUiClockAligned(60_000, [2, -1, 3])).toBe(true);
  expect(controlUiClockAligned(60_000, [51, 0])).toBe(false);
  expect(controlUiClockAligned(1_000, [11])).toBe(false);
  expect(controlUiClockAligned(60_000, [Number.NaN])).toBe(false);
});

it("retains partial request updates and fatal evidence while excluding warmup", () => {
  const row = {
    requestId: "one",
    sentMs: 110,
    ackMs: null,
    firstDeltaMs: null,
    finalMs: null,
    error: null,
  };
  const text =
    [
      { type: "request", request: { ...row, requestId: "warm", sentMs: 90 } },
      { type: "request", request: row },
      { type: "request", request: { ...row, ackMs: 112 } },
      { type: "error", error: "driver disconnected" },
      { type: "delta", sessionKey: "session", runId: "followup", firstDeltaMs: 113 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + '\n{"type":';
  expect(parseControlUiJournal(text, "100000000")).toEqual({
    requests: [{ ...row, sentMs: 10, ackMs: 12 }],
    errors: ["driver disconnected", "Incomplete driver journal record"],
    streams: [{ sessionKey: "session", runId: "followup", firstDeltaMs: 13 }],
  });
  expect(parseControlUiJournal(text, null).requests).toEqual([]);
});
