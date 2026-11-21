import { expect, it } from "vitest";
import { expectCollected, weak, weakControl } from "./session-collection.test-support.js";
import { getSessionListBaseMiss } from "./session-list-diagnostics.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import { shareSidebarSessionRows } from "./session-row-presentation.js";
import { serializeSessionRow } from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("collects replaced sidebar rows and packed replies while keeping historical deltas usable", async () => {
  const cache = new SessionListViewCache();
  const view = cache.get("history");
  const retired: WeakRef<object>[] = [];
  const revisions: string[] = [];
  const control = weakControl();
  function publish(generation: number) {
    const rows: GatewaySessionRow[] = Array.from({ length: 3 }, (_, index) =>
      Object.freeze({
        key: `row-${index}`,
        kind: "direct",
        updatedAt: generation,
        rowMode: "sidebar",
        label: `${generation}-${index}-${"synthetic ".repeat(256)}`,
      }),
    );
    rows.forEach(serializeSessionRow);
    cache.setRows(view, rows, true);
    const reply = shareSidebarSessionRows(rows, undefined, view.rowHistory);
    revisions.push(reply.rowsRevision!);
    if (generation < 5) {
      retired.push(weak(rows), ...rows.map(weak));
      retired.push(weak(reply.sessions), ...reply.sessions.map(weak));
    }
  }
  try {
    for (let generation = 0; generation <= 5; generation++) {
      publish(generation);
    }
    await expectCollected(control, ...retired);
    const current = view.rows!;
    const reduced = [current[2]!, current[0]!];
    cache.setRows(view, [current[1]!, current[2]!], true);
    cache.setRows(view, reduced, true);
    const delta = shareSidebarSessionRows(reduced, `delta:${revisions[5]}`, view.rowHistory);
    expect(delta).toMatchObject({
      sessions: [],
      rowsDelta: { baseRevision: revisions[5], order: [2, 0] },
    });
    const oldest = shareSidebarSessionRows(reduced, `delta:${revisions[0]}`, view.rowHistory);
    expect(oldest.rowsDelta).toBeUndefined();
    expect(getSessionListBaseMiss(oldest)).toBe("all-rows-changed");
    expect(view.rowHistory).toHaveLength(7);
  } finally {
    cache.clear();
  }
});

it.each(["eviction", "clear"])("releases the current sidebar reply after %s", async (reason) => {
  const cache = new SessionListViewCache();
  function publish() {
    const rows: GatewaySessionRow[] = [{ key: "one", kind: "direct", updatedAt: 1 }];
    const reply = shareSidebarSessionRows(rows);
    cache.setRows(cache.get("cold"), rows, true);
    return [rows, ...rows, reply.sessions, ...reply.sessions].map(weak);
  }
  const refs = publish();
  if (reason === "clear") {
    cache.clear();
  } else {
    for (let index = 0; index < 512; index++) {
      cache.get(`new-${index}`);
    }
  }
  try {
    await expectCollected(...refs);
  } finally {
    cache.clear();
  }
});
