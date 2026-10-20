import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { registerSerializedJsonArray } from "./serialized-json.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import { serializeSessionRow } from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const row: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1, rowMode: "sidebar" };
type Counters = { views: number; refs: number; estimatedBytes: number };
async function flushReports() {
  await setImmediate();
  await waitForDiagnosticEventsDrained();
}
async function withCache(
  run: (fixture: {
    cache: SessionListViewCache;
    retained: Counters;
    reports: Counters[];
    retirements: string[];
  }) => Promise<void>,
) {
  const cache = new SessionListViewCache();
  const retained = { views: 0, refs: 0, estimatedBytes: 0 };
  const reports: Counters[] = [];
  const retirements: string[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.retention") {
      const counters = {
        views: event.views,
        refs: event.refs,
        estimatedBytes: event.estimatedBytes,
      };
      Object.assign(retained, counters);
      reports.push(counters);
    } else if (event.type === "sessions.list.baseline.retired") {
      retirements.push(event.cause);
    }
  });
  try {
    await run({ cache, retained, reports, retirements });
  } finally {
    cache.clear();
    await flushReports();
    stop();
  }
  return { retained, reports, retirements };
}

it("charges shared current encodings once and replaces their cost with identity vectors on retirement", async () => {
  const encodedRow = { ...row, label: "é".repeat(1_024) };
  const rows = [encodedRow];
  const encoded = serializeSessionRow(encodedRow);
  registerSerializedJsonArray(rows, [encoded]);
  const fixture = await withCache(async ({ cache, retained }) => {
    const view = cache.get("encoded");
    const emptyBytes = view.bytes;
    cache.setRows(view, rows, true);
    expect(view.bytes - emptyBytes).toBe(
      8 + encoded.length * 2 + Buffer.byteLength(`[${encoded}]`),
    );
    const shared = cache.get("shared");
    cache.setRows(shared, [encodedRow], true);
    await flushReports();
    expect(retained.estimatedBytes).toBe(view.bytes + shared.bytes - encoded.length * 2);
    cache.retireRows(view);
    expect(view.bytes - emptyBytes).toBe(8 + 160);
    expect(view.rows).toBeUndefined();
    expect(view.rowHistory?.[0]?.ids).toHaveLength(1);
    await flushReports();
    expect(retained.estimatedBytes).toBe(view.bytes + shared.bytes);
  });
  expect(fixture.retained.estimatedBytes).toBe(0);
});

it("coalesces a turn of retention updates into one report with the final counters", async () => {
  await withCache(async ({ cache, reports }) => {
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
});

it("evicts least recently used views under byte pressure and releases all accounting", async () => {
  const fixture = await withCache(async ({ cache, retained, retirements }) => {
    const evictionRow: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1 };
    const rows = Array.from({ length: 1_000_000 }, () => evictionRow);
    const cold = cache.get("cold");
    cache.setRows(cold, rows, true);
    const hot = cache.get("hot");
    cache.setRows(hot, rows, true);
    cache.setRows(cache.get("warm"), rows, true);
    expect(cache.get("hot").rows).toBe(rows);
    cache.setRows(cache.get("new"), rows, true);
    cache.setRows(cache.get("newer"), rows, true);
    await flushReports();
    expect(retained.views).toBe(4);
    expect(retained.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(retirements).toEqual(["view-evicted"]);
    expect(cache.get("hot").rows).toBe(rows);
    expect(cache.get("cold").rows).toBeUndefined();
    // An oversized request still owns its response, but cannot retain a baseline.
    const oversized = cache.get("oversized");
    cache.setRows(
      oversized,
      Array.from({ length: 4_194_304 }, () => evictionRow),
      true,
    );
    expect(cache.get("oversized").rows).toBeUndefined();
    expect(cache.get("hot").rows).toBe(rows);
  });
  expect(fixture.retained).toMatchObject({ views: 0, refs: 0, estimatedBytes: 0 });
  expect(fixture.retirements).toEqual(["view-evicted", "view-evicted"]);
});
