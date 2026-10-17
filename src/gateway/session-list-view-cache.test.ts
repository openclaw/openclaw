import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("coalesces a turn of retention updates into one report with the final counters", async () => {
  const cache = new SessionListViewCache();
  const reports: { views: number; refs: number; estimatedBytes: number }[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.retention") {
      reports.push({ views: event.views, refs: event.refs, estimatedBytes: event.estimatedBytes });
    }
  });
  const row: GatewaySessionRow = {
    key: "one",
    kind: "direct",
    updatedAt: 1,
    rowMode: "sidebar",
  };
  try {
    for (let index = 0; index < 40; index++) {
      const view = cache.get(`view-${index}`);
      cache.setRows(view, [row], true);
      cache.retireRows(view);
    }
    cache.clear();
    cache.setRows(cache.get("final"), [row, row], false);
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    expect(reports).toEqual([{ views: 1, refs: 2, estimatedBytes: 1_050 }]);
    cache.clear();
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    expect(reports).toEqual([
      { views: 1, refs: 2, estimatedBytes: 1_050 },
      { views: 0, refs: 0, estimatedBytes: 0 },
    ]);
  } finally {
    cache.clear();
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    stop();
  }
});

it("evicts least recently used views under byte pressure and releases all accounting", async () => {
  const cache = new SessionListViewCache();
  let retained = { views: 0, refs: 0, estimatedBytes: 0 };
  const retirements: string[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.retention") {
      retained = { views: event.views, refs: event.refs, estimatedBytes: event.estimatedBytes };
    } else if (event.type === "sessions.list.baseline.retired") {
      retirements.push(event.cause);
    }
  });
  const row: GatewaySessionRow = { key: "one", kind: "direct", updatedAt: 1 };
  const rows = Array.from({ length: 1_000_000 }, () => row);
  try {
    const cold = cache.get("cold");
    cache.setRows(cold, rows, true);
    const hot = cache.get("hot");
    cache.setRows(hot, rows, true);
    cache.setRows(cache.get("warm"), rows, true);
    expect(cache.get("hot").rows).toBe(rows);
    cache.setRows(cache.get("new"), rows, true);
    cache.setRows(cache.get("newer"), rows, true);
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    expect(retained.views).toBe(4);
    expect(retained.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(retirements).toEqual(["view-evicted"]);
    expect(cache.get("hot").rows).toBe(rows);
    expect(cache.get("cold").rows).toBeUndefined();
    // An oversized request still owns its response, but cannot retain a baseline.
    const oversized = cache.get("oversized");
    cache.setRows(
      oversized,
      Array.from({ length: 4_194_304 }, () => row),
      true,
    );
    expect(cache.get("oversized").rows).toBeUndefined();
    expect(cache.get("hot").rows).toBe(rows);
  } finally {
    cache.clear();
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    stop();
  }
  expect(retained).toMatchObject({ views: 0, refs: 0, estimatedBytes: 0 });
  expect(retirements).toEqual(["view-evicted", "view-evicted"]);
});
