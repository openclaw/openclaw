import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { registerSerializedJsonArray } from "./serialized-json.js";
import { SessionListViewCache, shareSessionRowFacts } from "./session-list-view-cache.js";
import { sessionRowsRevision } from "./session-row-identity.js";
import { serializeSessionRow } from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const row: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1, rowMode: "sidebar" };

it("packs all-row facts without building or encoding their identical recipient lists", () => {
  const rows = ["one", "two", "three"].map((key) => ({
    key,
    kind: "direct" as const,
    updatedAt: 1,
    pinned: false,
    visibility: "shared" as const,
  }));
  using join = vi.spyOn(Array.prototype, "join");
  const push = Array.prototype.push;
  let indices = 0;
  let packed: ReturnType<typeof shareSessionRowFacts>;
  try {
    // oxlint-disable-next-line no-extend-native -- Vitest spies use push internally; restore this synchronous work counter in finally.
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      if (items.length === 1 && typeof items[0] === "number") {
        indices++;
      }
      return push.apply(this, items);
    };
    packed = shareSessionRowFacts(rows);
  } finally {
    // oxlint-disable-next-line no-extend-native -- Restore the original method after the synchronous work counter.
    Array.prototype.push = push;
  }
  const joins = join.mock.calls.length;
  join.mockRestore();
  expect(joins).toBe(0);
  expect(indices).toBe(rows.length);
  expect(packed.sharedFacts).toEqual([{ pinned: false, visibility: "shared" }]);
  expect(packed.sessions.map((value) => value.sharedFacts)).toEqual([[0], [0], [0]]);
});

it("does not reread required row facts when only a sibling identity changes", () => {
  let reads = 0;
  const stable: GatewaySessionRow = Object.freeze({
    get key() {
      reads++;
      return "stable";
    },
    kind: "direct",
    updatedAt: 1,
    label: "Stable",
    pinned: false,
  });
  const sibling = { ...row, label: "Sibling", pinned: false };
  const first = shareSessionRowFacts([stable, sibling]);
  reads = 0;
  const changed = shareSessionRowFacts([stable, { ...sibling, updatedAt: 2 }]);
  expect(changed.sessions[0]).toBe(first.sessions[0]);
  expect(reads).toBe(0);
});

let cache: SessionListViewCache;
let reports: { views: number; refs: number; estimatedBytes: number }[];
let retirements: string[];
let stop: () => void;
async function flushReports() {
  await setImmediate();
  await waitForDiagnosticEventsDrained();
}
beforeEach(() => {
  cache = new SessionListViewCache();
  reports = [];
  retirements = [];
  stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.retention") {
      const { views, refs, estimatedBytes } = event;
      reports.push({ views, refs, estimatedBytes });
    } else if (event.type === "sessions.list.baseline.retired") {
      retirements.push(event.cause);
    }
  });
});
afterEach(async () => {
  const before = [...retirements];
  try {
    cache.clear();
    await flushReports();
    expect(reports.at(-1)).toEqual({ views: 0, refs: 0, estimatedBytes: 0 });
    expect(retirements).toEqual(before);
  } finally {
    stop();
  }
});

it("charges shared current encodings once and replaces their cost with identity vectors on retirement", async () => {
  const encodedRow = { ...row, label: "é".repeat(1_024) };
  const rows = [encodedRow];
  const encoded = serializeSessionRow(encodedRow);
  registerSerializedJsonArray(rows, [encoded]);
  const view = cache.get("encoded");
  const emptyBytes = view.bytes;
  cache.setRows(view, rows, true);
  expect(view.bytes - emptyBytes).toBe(16 + encoded.length * 2 + Buffer.byteLength(`[${encoded}]`));
  const shared = cache.get("shared");
  cache.setRows(shared, [encodedRow], true);
  await flushReports();
  expect(reports.at(-1)?.estimatedBytes).toBe(view.bytes + shared.bytes - encoded.length * 2);
  cache.retireRows(view);
  expect(view.bytes - emptyBytes).toBe(8 + 160);
  expect(view.rows).toBeUndefined();
  expect(view.rowHistory?.[0]?.ids).toHaveLength(1);
  await flushReports();
  expect(reports.at(-1)?.estimatedBytes).toBe(view.bytes + shared.bytes);
});

it("coalesces a turn of retention updates into one report with the final counters", async () => {
  for (let index = 0; index < 40; index++) {
    const view = cache.get(`view-${index}`);
    cache.setRows(view, [row], true);
    cache.retireRows(view);
  }
  cache.clear();
  cache.setRows(cache.get("final"), [row, row], false);
  await flushReports();
  expect(reports).toEqual([{ views: 1, refs: 2, estimatedBytes: 1_050 }]);
  cache.clear();
  await flushReports();
  expect(reports).toEqual([
    { views: 1, refs: 2, estimatedBytes: 1_050 },
    { views: 0, refs: 0, estimatedBytes: 0 },
  ]);
});

it("charges an encoding prepared after a shared row was admitted until its last view retires", async () => {
  const lateRow = { ...row, label: "Late encoding" };
  const other = { ...row, key: "other" };
  const first = cache.get("first");
  cache.setRows(first, [lateRow, other], true, 0, () => 30);
  const encodedBytes = serializeSessionRow(lateRow).length * 2;
  const singleton = cache.get("singleton");
  cache.setRows(singleton, [lateRow], true);
  await flushReports();
  expect(reports.at(-1)?.estimatedBytes).toBe(first.bytes + singleton.bytes + 60 + encodedBytes);

  cache.retireRows(singleton);
  await flushReports();
  expect(reports.at(-1)?.estimatedBytes).toBe(first.bytes + singleton.bytes + 60 + encodedBytes);
  cache.retireRows(first);
  await flushReports();
  expect(reports.at(-1)?.estimatedBytes).toBe(first.bytes + singleton.bytes);
});

it("evicts least recently used views under byte pressure and releases all accounting", async () => {
  const evictionRow: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1 };
  const rows = Array.from({ length: 1_000_000 }, () => evictionRow);
  const setRows = (key: string, values = rows) => cache.setRows(cache.get(key), values, true);
  setRows("cold");
  setRows("hot");
  setRows("warm");
  expect(cache.get("hot").rows).toBe(rows);
  setRows("new");
  setRows("newer");
  await flushReports();
  expect(reports.at(-1)).toMatchObject({ views: 4 });
  expect(reports.at(-1)?.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(retirements).toEqual(["view-evicted"]);
  expect(cache.get("hot").rows).toBe(rows);
  expect(cache.get("cold").rows).toBeUndefined();
  setRows(
    "oversized",
    Array.from({ length: 4_194_304 }, () => evictionRow),
  );
  expect(cache.get("oversized").rows).toBeUndefined();
  expect(cache.get("hot").rows).toBe(rows);
  await flushReports();
  expect(retirements).toEqual(["view-evicted", "view-evicted"]);
  cache.clear();
  setRows("small", [row]);
  const growing = cache.get("growing");
  cache.setRows(growing, rows, true, 18 * 1024 * 1024);
  cache.setRows(growing, rows.slice(), true, 18 * 1024 * 1024);
  expect(cache.get("growing").rows).toBeUndefined();
  expect(cache.get("small").rows).toEqual([row]);
  await flushReports();
});

it("keeps readers' latest baselines when older generations fill the byte budget", async () => {
  const rows: GatewaySessionRow[] = Array.from({ length: 2_048 }, (_, index) => ({
    ...row,
    key: `row-${index}`,
  }));
  const readers = Array.from({ length: 64 }, (_, index) => ({
    key: `reader-${index}`,
    revision: "",
  }));
  let misses = 0;
  for (let generation = 0; generation < 40; generation++) {
    const current = [...rows.slice(1), { ...rows[0]!, updatedAt: generation }];
    for (const reader of readers) {
      const view = cache.get(reader.key);
      cache.setRows(view, current, true);
      if (reader.revision && !view.rowHistory?.some((base) => base.revision === reader.revision)) {
        misses++;
      }
      reader.revision = sessionRowsRevision(current);
    }
  }
  await flushReports();
  expect(misses).toBe(0);
  expect(retirements).toContain("history-evicted");
  expect(retirements).not.toContain("view-evicted");
  expect(reports.at(-1)?.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
});
