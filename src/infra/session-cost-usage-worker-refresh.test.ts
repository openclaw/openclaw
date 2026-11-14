import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "../config/sessions/session-accessor.sqlite-parent-fork.js";
import {
  createMemorySessionMessageCutReader,
  planInPlaceSessionMessageCut,
  planSessionMessageCut,
} from "../config/sessions/session-message-cut-plan.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import { selectBilledTranscriptEvents } from "./session-cost-usage-inherited.js";
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
function expectMeasured(entry: UsageCostRollupEntry, total: number) {
  const totals = entry.rollup.buckets[String(timestamp)]?.totals;
  expect(totals).toMatchObject({ totalTokens: total, totalCost: total, missingCostEntries: 0 });
  expect(totals).not.toHaveProperty("usageReport");
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

it("ignores unknown usage across incremental refreshes", async () => {
  const before = await scan(initial);
  const interrupted = [...initial, makeRow(9, "aborted", "a", 100, true)];
  const afterAbort = await scan(interrupted, before);
  expectMeasured(afterAbort, 3);
  expectMeasured(
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
  // Three turns, a rewind back to the first reply, then two more turns: base
  // reports 206 for that history across its retired copy and its successor, and
  // the one in-place transcript reports the same.
  expectUsage(result, 206, 5, "chosen-tail");
  expect(result.checkpoint).toMatchObject({ maxSeq: 20, eventCount: 6 });
});

it.each<[string, Row[], [number, number, string], string?]>([
  ["append", [...appended, makeRow(16, "d", "c", 16)], [31, 5, "d"]],
  // A rewind to the first reply keeps the spend of the branch it displaced; base
  // reports 15 for four turns followed by that rewind.
  ["leaf", [...appended, control(20, "leaf", "switch", "c", "root")], [15, 4, "root"]],
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

const userEvent = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: `${id} question` },
});
const answerEvent = (id: string, parentId: string, tokens: number) => {
  const { event } = makeRow(0, id, parentId, tokens);
  const message = { ...(event.message as Record<string, unknown>), stopReason: "stop" };
  return { ...event, message: { ...message, content: [{ type: "text", text: `${id} answer` }] } };
};
/** u1 -> a1(10), the never-active sibling u2b -> a2b(40), then the active u2 -> a2(20). */
const branchedSource = (): TranscriptEvent[] => [
  createSessionTranscriptHeader({ sessionId: "source" }),
  userEvent("u1", null),
  answerEvent("a1", "u1", 10),
  userEvent("u2b", "a1"),
  answerEvent("a2b", "u2b", 40),
  userEvent("u2", "a1"),
  answerEvent("a2", "u2", 20),
];
// Stored transcripts keep the session header at seq 0.
const scanWithNewTurn = async (events: readonly unknown[], newTurnParent: string) =>
  scan(
    [...events.filter(isRecord), answerEvent("new", newTurnParent, 5)].map((event, index) => ({
      seq: index,
      event,
    })),
  );
const billedTokens = (entry: UsageCostRollupEntry) =>
  Object.values(entry.rollup.buckets).reduce((sum, b) => sum + b.totals.totalTokens, 0);

// A fork copies the counted active path, so the source already counts every copied turn and the
// copy only adds its own 5-token turn.
it.each([
  ["fork", "a1", 5],
  ["parent fork", "a2", 5],
] as const)(
  "counts history copied by a %s once, in its source transcript",
  async (mode, newTurnParent, expected) => {
    const source = branchedSource();
    let copy: unknown[];
    if (mode === "parent fork") {
      const forkSource = resolveParentForkSourceTranscript(source, "last-completed");
      expect(forkSource).not.toBeNull();
      copy = buildForkedChildTranscriptEvents({
        parentSessionFile: "source",
        source: forkSource!,
        targetSessionId: "copy",
      });
    } else {
      const plan = planSessionMessageCut(
        { sessionId: "source", lifecycleRevision: "r1", updatedAt: timestamp },
        source,
        {
          mode: "fork",
          entryId: "u2",
          expectedState: { sessionId: "source", lifecycleRevision: "r1" },
          sourceKey: "agent:main:source",
          canonicalSourceKey: "agent:main:source",
          targetKey: "agent:main:copy",
        },
      );
      expect(plan.status).toBe("prepared");
      copy = plan.status === "prepared" ? plan.events : [];
    }
    expect(billedTokens(await scanWithNewTurn(copy, newTurnParent))).toBe(expected);
  },
);

// A maintenance rewrite re-appends one turn as a copy carrying `supersedesEntryId`
// and publishes its own leaf control, so the original and every copy become
// reachable billed paths. They are one spend: no model call happened.
it("bills each real turn once across rewrites, copies and displaced paths", async () => {
  const turn: TranscriptEvent[] = [
    createSessionTranscriptHeader({ sessionId: "source" }),
    userEvent("u1", null),
    answerEvent("a1", "u1", 10),
  ];
  const rewritten = [...turn];
  let superseded = "a1";
  for (const round of [1, 2]) {
    const copy = `a1-copy-${round}`;
    rewritten.push(
      { ...answerEvent(copy, "u1", 10), supersedesEntryId: superseded },
      {
        type: "leaf",
        id: `leaf-${round}`,
        parentId: superseded,
        targetId: copy,
      },
    );
    superseded = copy;
  }
  // Two rewrites of one 10-token turn: one spend, because no model call happened.
  expect(
    billedTokens(
      await scan(rewritten.map((event, seq) => ({ seq, event: event as Row["event"] }))),
    ),
  ).toBe(10);
  // A rewind and regenerate is two real turns: 10 displaced + 5 new.
  expect(billedTokens(await scanWithNewTurn(applyInPlaceCut(turn, "rewind", "u1"), "u1"))).toBe(15);
  // Rows without an id carry no navigation: with no leaf control the transcript is
  // one branch and every row is billed, as on base.
  const flat = Array.from({ length: 8 }, () => ({ message: answerEvent("f", "u1", 9).message }));
  expect(selectBilledTranscriptEvents(flat)).toHaveLength(8);
  // Three windows the merge base produced by copying on every cut: ids are copied
  // verbatim and `inheritedThrough` names the paths each source already counted,
  // so the family still reports its 70 tokens (10 + 40 + 20), each turn once.
  const window = (sessionId: string, inheritedThrough: string[], leaves: TranscriptEvent[]) => [
    createSessionTranscriptHeader({
      sessionId,
      ...(inheritedThrough.length && { inheritedThrough }),
    }),
    ...branchedSource().slice(1),
    ...leaves,
  ];
  const switchLeaf = { type: "leaf", id: "97c81933", parentId: "a2", targetId: "a2b" };
  const rewindLeaf = { type: "leaf", id: "7d3f38f6", parentId: "97c81933", targetId: "a1" };
  const tokensOf = (rows: TranscriptEvent[]) =>
    selectBilledTranscriptEvents(rows.filter(isRecord)).reduce((total, row) => {
      const usage = isRecord(row.message) ? row.message.usage : undefined;
      const tokens = isRecord(usage) ? usage.totalTokens : undefined;
      return total + (typeof tokens === "number" ? tokens : 0);
    }, 0);
  expect(
    [
      window("legacy-source", [], []),
      window("legacy-after-switch", ["a2"], [switchLeaf]),
      window("legacy-after-rewind", ["a2", "a2b"], [switchLeaf, rewindLeaf]),
    ].reduce((sum, rows) => sum + tokensOf(rows), 0),
  ).toBe(70);
});

/** The real in-place install: one appended leaf control on the same transcript. */
function applyInPlaceCut(
  events: readonly TranscriptEvent[],
  mode: "rewind" | "switch",
  entryId: string,
): TranscriptEvent[] {
  const expectedState = { sessionId: "source", lifecycleRevision: "r1" };
  const plan = planInPlaceSessionMessageCut(
    { ...expectedState, updatedAt: timestamp },
    createMemorySessionMessageCutReader(events),
    {
      mode,
      entryId,
      expectedState,
      sourceKey: "agent:main:source",
      canonicalSourceKey: "agent:main:source",
      targetKey: "agent:main:source",
    },
  );
  expect(plan.status).toBe("prepared");
  return plan.status === "prepared" ? [...events, plan.leafEvent] : [...events];
}

// Rewind and branch switch append a leaf control instead of copying, so the one transcript now
// reports what the retired copy and its successor reported together. Each expected total is what
// the base commit reports for the same user history (handoff USAGE-PARITY.md).
it.each([
  ["rewind", [["rewind", "u2"]], "a1", 35],
  ["switch", [["switch", "a2b"]], "a2b", 75],
  [
    "switch back",
    [
      ["switch", "a2b"],
      ["switch", "a2"],
    ],
    "a2",
    75,
  ],
] as ReadonlyArray<
  readonly [string, ReadonlyArray<readonly ["rewind" | "switch", string]>, string, number]
>)(
  "bills every historically active path after an in-place %s",
  async (_label, cuts, newTurnParent, expected) => {
    let events = branchedSource();
    for (const [mode, entryId] of cuts) {
      events = applyInPlaceCut(events, mode, entryId);
    }
    expect(billedTokens(await scanWithNewTurn(events, newTurnParent))).toBe(expected);
  },
);

// Canonical navigation, not the physical append cursor or billing's emission
// order, decides what is billed and whose turn each reply answers. Every case
// extends u1@12:00:00 -> a1@12:00:01, reporting tokens, latency samples and the
// cursor the next append-only scan continues from.
const stamp = <T extends Record<string, unknown>>(event: T, second: number) => ({
  ...event,
  timestamp: new Date(timestamp + second * 1_000).toISOString(),
});
const u = (id: string, parentId: string | null, second: number) =>
  stamp(userEvent(id, parentId), second);
const a = (id: string, parentId: string, second: number) =>
  stamp(answerEvent(id, parentId, 1), second);
const leafRow = (parentId: string, targetId: string | null) =>
  ({ type: "leaf", id: "cut", parentId, targetId }) as Record<string, unknown>;
const latencySamples = (entry: UsageCostRollupEntry) =>
  Object.values(entry.rollup.buckets)
    .flatMap((bucket) => bucket.latency.centroids.map((centroid) => centroid.value))
    .toSorted((left, right) => left - right);
const flatUserEvent = { type: "message", message: { role: "user", content: "q" } };
const side = { type: "custom", id: "s", parentId: "u1", appendMode: "side" };
const timingCases: Array<[string, Record<string, unknown>[], number, number[], number?]> = [
  // A side row moves the append cursor off the active branch, so a rewind must
  // still bill a1: the retired copy kept counting the displaced branch.
  ["side cursor", [side, leafRow("s", null)], 1, [1_000]],
  // Sibling replies each answer their own user turn, whichever one is active.
  ["sibling switch", [a("a2", "u1", 3), leafRow("a2", "a1")], 2, [1_000, 3_000], 0],
  // With no new turn the cursor stays on the active branch's own turn, so the
  // reply at 12:00:06 measures 6 s, as the never-rewound control does.
  ["rewind", [u("u2", "a1", 2), leafRow("u2", "a1"), a("a4", "a1", 6)], 2, [1_000, 6_000], 0],
  [
    "rewind and continue",
    [u("u2", "a1", 2), leafRow("u2", "a1"), u("u3", "a1", 4), a("a3", "u3", 5), a("a4", "a3", 6)],
    3,
    [1_000, 1_000, 2_000],
    4,
  ],
  ["never rewound", [a("a4", "a1", 6)], 2, [1_000, 6_000], 0],
];
it.each(timingCases)(
  "bills and times every branch from canonical navigation (%s)",
  async (_label, extra, tokens, samples, cursorSecond) => {
    const result = await scan(
      [u("u1", null, 0), a("a1", "u1", 1), ...extra].map((event, seq) => ({
        seq,
        event: event as Row["event"],
      })),
    );
    expect(billedTokens(result)).toBe(tokens);
    expect(latencySamples(result)).toEqual(samples);
    expect(result.rollup.lastUserTimestamp).toBe(
      cursorSecond === undefined ? undefined : timestamp + cursorSecond * 1_000,
    );
  },
);

// A transcript without navigation ids is one flat branch, as its legacy appender
// wrote it: the first scan keeps the user turn its appended reply measures from.
it("times an appended reply against a flat transcript's cursor", async () => {
  const flat = [{ seq: 0, event: stamp(flatUserEvent, 0) }];
  const first = await scan(flat);
  expect(first.rollup.lastUserTimestamp).toBe(timestamp);
  const tail = [...flat, { seq: 1, event: stamp(makeRow(1, "a1", null, 1).event, 2) }];
  expect(latencySamples(await scan(tail, first))).toEqual([2_000]);
});
