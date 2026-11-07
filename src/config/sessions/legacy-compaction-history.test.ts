import { expect, it } from "vitest";
import {
  readLegacyCompactionHistory,
  readLegacyCompactionMetrics,
  readLegacyCompactionSnapshotPaths,
} from "./legacy-compaction-history.js";

const checkpoint = {
  sessionId: "session-1",
  preCompaction: { sessionId: "session-1", sessionFile: "/sessions/before.jsonl" },
  postCompaction: {
    sessionId: "session-1",
    sessionFile: "/sessions/after.jsonl",
    entryId: "entry-9",
  },
  tokensBefore: 12_000,
  tokensAfter: 4_000,
};

const entryWith = (compactionCheckpoints: unknown) => ({ compactionCheckpoints });

it("reports no history when the entry carries no checkpoints", () => {
  expect(readLegacyCompactionHistory({})).toEqual([]);
  expect(readLegacyCompactionHistory({ compactionCheckpoints: null })).toEqual([]);
});

it("reads checkpoints that name both compaction sides", () => {
  expect(readLegacyCompactionHistory(entryWith([checkpoint]))).toEqual([checkpoint]);
});

it("keeps metrics only for checkpoints that name a post-compaction entry", () => {
  expect(readLegacyCompactionMetrics(entryWith([checkpoint]))).toEqual([
    { entryId: "entry-9", tokensBefore: 12_000, tokensAfter: 4_000 },
  ]);
  expect(
    readLegacyCompactionMetrics(
      entryWith([{ ...checkpoint, postCompaction: { sessionId: "session-1" } }]),
    ),
  ).toEqual([]);
});

it("drops non-finite token measurements instead of throwing", () => {
  expect(
    readLegacyCompactionMetrics(
      entryWith([{ ...checkpoint, tokensBefore: Number.POSITIVE_INFINITY }]),
    ),
  ).toEqual([{ entryId: "entry-9", tokensBefore: undefined, tokensAfter: 4_000 }]);
});

it("collects trimmed snapshot paths from both compaction sides", () => {
  expect(
    readLegacyCompactionSnapshotPaths(
      entryWith([
        {
          ...checkpoint,
          preCompaction: { sessionId: "session-1", sessionFile: "  /sessions/before.jsonl  " },
        },
      ]),
    ),
  ).toEqual(["/sessions/before.jsonl", "/sessions/after.jsonl"]);
});

it("skips blank snapshot paths", () => {
  expect(
    readLegacyCompactionSnapshotPaths(
      entryWith([
        {
          ...checkpoint,
          preCompaction: { sessionId: "session-1", sessionFile: "   " },
          postCompaction: { sessionId: "session-1", entryId: "entry-9" },
        },
      ]),
    ),
  ).toEqual([]);
});

// Cleanup protects stored generations by reading these paths. A malformed reference must
// stay unreclaimable, so the path reader fails closed while the metrics reader degrades.
it.each([
  ["checkpoints are not an array", "corrupt"],
  ["a checkpoint is not a record", [null]],
  ["a checkpoint omits its pre-compaction side", [{ postCompaction: {} }]],
  ["a checkpoint omits its post-compaction side", [{ preCompaction: {} }]],
  [
    "a snapshot path is not a string",
    [{ ...checkpoint, preCompaction: { sessionId: "session-1", sessionFile: 7 } }],
  ],
])("fails closed when %s", (_label, compactionCheckpoints) => {
  const entry = entryWith(compactionCheckpoints);
  expect(() => readLegacyCompactionSnapshotPaths(entry)).toThrow(TypeError);
  expect(readLegacyCompactionMetrics(entry)).toEqual([]);
});
