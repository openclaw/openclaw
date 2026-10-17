import { expect, it } from "vitest";
import {
  prepareSessionAncestor,
  SessionAncestorReferences,
} from "./session-ancestor-references.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("preserves presentation clocks and the delivered baseline when serialization fails", () => {
  const references = new SessionAncestorReferences();
  const row: GatewaySessionRow = Object.freeze({
    key: "agent:main:parent",
    sessionId: "parent",
    kind: "direct",
    updatedAt: 1,
    snapshotAt: 10,
    label: "Parent",
  });
  const first = references.prepare([prepareSessionAncestor(row)]);
  first.delivered();
  expect(first.ancestorSessions[0]?.snapshotAt).toBe(10);
  expect(row.snapshotAt).toBe(10);

  const unavailable = Object.freeze({
    ...row,
    snapshotAt: 20,
    get label(): string {
      throw new Error("presentation unavailable");
    },
  });
  expect(() => references.prepare([prepareSessionAncestor(unavailable)])).toThrow(
    "presentation unavailable",
  );
  expect(unavailable.snapshotAt).toBe(20);
  const nextRow = Object.freeze({ ...row, snapshotAt: 20 });
  const next = references.prepare([prepareSessionAncestor(nextRow)]);
  expect(next.ancestorSessions).toEqual([]);
  expect(next.ancestorSessionRefs).toEqual([
    expect.objectContaining({
      revision: first.ancestorSessions[0]?.ancestorRevision,
      snapshotAt: 20,
    }),
  ]);
  expect(nextRow.snapshotAt).toBe(20);

  const { snapshotAt: _snapshotAt, ...unclockedRow } = nextRow;
  const unclocked = references.prepare([prepareSessionAncestor(unclockedRow)]);
  unclocked.delivered();
  expect(Object.hasOwn(unclockedRow, "snapshotAt")).toBe(false);
  const reclockedRow = Object.freeze({ ...unclockedRow, snapshotAt: 30 });
  expect(
    references.prepare([prepareSessionAncestor(reclockedRow)]).ancestorSessionRefs,
  ).toBeUndefined();
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
