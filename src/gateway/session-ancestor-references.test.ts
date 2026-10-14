import { expect, it } from "vitest";
import {
  prepareSessionAncestor,
  SessionAncestorReferences,
} from "./session-ancestor-references.js";
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
  const first = references.prepare([prepareSessionAncestor(row)]);
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
  expect(() => references.prepare([prepareSessionAncestor(row)])).toThrow(
    "presentation unavailable",
  );
  expect(row.snapshotAt).toBe(20);
  Object.defineProperty(row, "label", { value: "Parent" });
  const next = references.prepare([prepareSessionAncestor(row)]);
  expect(next.ancestorSessions).toEqual([]);
  expect(next.ancestorSessionRefs).toEqual([
    expect.objectContaining({
      revision: first.ancestorSessions[0]?.ancestorRevision,
      snapshotAt: 20,
    }),
  ]);
  expect(row.snapshotAt).toBe(20);

  delete row.snapshotAt;
  const unclocked = references.prepare([prepareSessionAncestor(row)]);
  unclocked.delivered();
  expect(Object.hasOwn(row, "snapshotAt")).toBe(false);
  row.snapshotAt = 30;
  expect(references.prepare([prepareSessionAncestor(row)]).ancestorSessionRefs).toBeUndefined();
});

it.each([
  { bound: "row count", count: 129, label: "ancestor", snapshotAt: 2 },
  { bound: "total content", count: 65, label: "a".repeat(2048), snapshotAt: 2 },
  { bound: "individual content", count: 1, label: "a".repeat(128 * 1024), snapshotAt: 3 },
])(
  "resends an ancestor in full after reaching the $bound bound",
  ({ count, label, snapshotAt }) => {
    const references = new SessionAncestorReferences();
    const rows = Array.from({ length: count }, (_, index): GatewaySessionRow => ({
      key: `agent:main:ancestor-${index}`,
      ...(count > 1 ? { sessionId: `ancestor-${index}` } : {}),
      kind: "direct",
      updatedAt: 1,
      snapshotAt: 2,
      label,
    }));
    for (const row of rows) {
      references.prepare([prepareSessionAncestor(row)]).delivered();
    }

    if (count > 1) {
      expect(
        references.prepare([prepareSessionAncestor(rows.at(-1)!)]).ancestorSessionRefs,
      ).toEqual([expect.objectContaining({ key: rows.at(-1)!.key })]);
    }
    const row = { ...rows[0]!, snapshotAt };
    const evicted = references.prepare([prepareSessionAncestor(row)]);
    expect(evicted.ancestorSessions).toEqual([expect.objectContaining(row)]);
    expect(evicted.ancestorSessionRefs).toBeUndefined();
  },
);
