import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { registerSerializedJsonArray } from "./serialized-json.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import { serializeSessionRow } from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const row: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1, rowMode: "sidebar" };
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
  expect(view.bytes - emptyBytes).toBe(8 + encoded.length * 2 + Buffer.byteLength(`[${encoded}]`));
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
});
