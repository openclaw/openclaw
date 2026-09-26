import { expect, it } from "vitest";
import { SessionAncestorReferences } from "./session-ancestor-references.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("preserves presentation clocks and the delivered baseline when serialization fails", () => {
  const references = new SessionAncestorReferences();
  const row: GatewaySessionRow = {
    key: "agent:main:parent",
    sessionId: "parent",
    kind: "direct",
    updatedAt: 1,
    snapshotAt: 10,
    label: "Parent",
  };
  const first = references.prepare([row]);
  first.delivered();
  expect(first.ancestorSessions[0]?.snapshotAt).toBe(10);
  expect(row.snapshotAt).toBe(10);

  row.snapshotAt = 20;
  Object.defineProperty(row, "label", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("presentation unavailable");
    },
  });
  expect(() => references.prepare([row])).toThrow("presentation unavailable");
  expect(row.snapshotAt).toBe(20);
  Object.defineProperty(row, "label", { value: "Parent" });
  const next = references.prepare([row]);
  expect(next.ancestorSessions).toEqual([]);
  expect(next.ancestorSessionRefs).toEqual([
    expect.objectContaining({
      revision: first.ancestorSessions[0]?.ancestorRevision,
      snapshotAt: 20,
    }),
  ]);
  expect(row.snapshotAt).toBe(20);

  delete row.snapshotAt;
  const unclocked = references.prepare([row]);
  unclocked.delivered();
  expect(Object.hasOwn(row, "snapshotAt")).toBe(false);
  row.snapshotAt = 30;
  expect(references.prepare([row]).ancestorSessionRefs).toBeUndefined();
});

it.each([
  { bound: "row count", count: 129, label: "ancestor" },
  { bound: "total content", count: 65, label: "a".repeat(2048) },
])("resends an evicted ancestor in full after reaching the $bound bound", ({ count, label }) => {
  const references = new SessionAncestorReferences();
  const rows = Array.from({ length: count }, (_, index): GatewaySessionRow => ({
    key: `agent:main:ancestor-${index}`,
    sessionId: `ancestor-${index}`,
    kind: "direct",
    updatedAt: 1,
    snapshotAt: 2,
    label,
  }));
  for (const row of rows) {
    references.prepare([row]).delivered();
  }

  expect(references.prepare([rows.at(-1)!]).ancestorSessionRefs).toEqual([
    expect.objectContaining({ key: rows.at(-1)!.key }),
  ]);
  const evicted = references.prepare([rows[0]!]);
  expect(evicted.ancestorSessions).toEqual([expect.objectContaining(rows[0]!)]);
  expect(evicted.ancestorSessionRefs).toBeUndefined();
});

it("resends an individual ancestor that exceeds the content bound", () => {
  const references = new SessionAncestorReferences();
  const row: GatewaySessionRow = {
    key: "agent:main:large-ancestor",
    kind: "direct",
    updatedAt: 1,
    snapshotAt: 2,
    label: "a".repeat(128 * 1024),
  };
  references.prepare([row]).delivered();

  const next = references.prepare([{ ...row, snapshotAt: 3 }]);
  expect(next.ancestorSessions).toEqual([expect.objectContaining({ ...row, snapshotAt: 3 })]);
  expect(next.ancestorSessionRefs).toBeUndefined();
});
