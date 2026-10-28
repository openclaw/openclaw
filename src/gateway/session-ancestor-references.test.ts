import { expect, it } from "vitest";
import { prepareSessionAncestor, ConnectionSessionRows } from "./session-ancestor-references.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const child: GatewaySessionRow = {
  key: "agent:main:child",
  kind: "direct",
  updatedAt: 1,
};

it("shares certified ancestor rows across histories only within their publication revision", () => {
  const row = Object.freeze({ ...child, key: "agent:main:parent", snapshotAt: 10 });
  const prepared = [prepareSessionAncestor(row)];
  const first = new ConnectionSessionRows();
  const second = new ConnectionSessionRows();
  const firstRevision = "00000000-0000-4000-8000-000000000001";
  const nextRevision = "00000000-0000-4000-8000-000000000002";
  const publish = (
    owner: ConnectionSessionRows,
    revision: Parameters<ConnectionSessionRows["prepareDelivery"]>[2],
  ) => owner.prepareDelivery(child, prepared, revision).ancestor!.ancestorSessions[0]!;
  const initial = publish(first, firstRevision);
  expect(publish(second, firstRevision)).toBe(initial);
  expect(initial).toEqual({ ...row, ancestorRevision: firstRevision });
  const next = publish(first, nextRevision);
  expect(next).not.toBe(initial);
  expect(next).toEqual({ ...row, ancestorRevision: nextRevision });
  expect(publish(second, nextRevision)).toBe(next);
  expect(publish(first, firstRevision)).toEqual(initial);
  expect(initial.ancestorRevision).toBe(firstRevision);
});

it("preserves presentation clocks and the delivered baseline when serialization fails", () => {
  const references = new ConnectionSessionRows();
  const row: GatewaySessionRow = {
    key: "agent:main:parent",
    sessionId: "parent",
    kind: "direct",
    updatedAt: 1,
    snapshotAt: 10,
    label: "Parent",
  };
  const first = references.prepareDelivery(child, [prepareSessionAncestor(row)]);
  references.deliver(first);
  expect(first.ancestor?.ancestorSessions[0]?.snapshotAt).toBe(10);
  expect(row.snapshotAt).toBe(10);

  row.snapshotAt = 20;
  Object.defineProperty(row, "label", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("presentation unavailable");
    },
  });
  expect(() => references.prepareDelivery(child, [prepareSessionAncestor(row)])).toThrow(
    "presentation unavailable",
  );
  expect(row.snapshotAt).toBe(20);
  Object.defineProperty(row, "label", { value: "Parent" });
  const next = references.prepareDelivery(child, [prepareSessionAncestor(row)]);
  expect(next.ancestor?.ancestorSessions).toEqual([]);
  expect(next.ancestor?.ancestorSessionRefs).toEqual([
    expect.objectContaining({
      revision: first.ancestor?.ancestorSessions[0]?.ancestorRevision,
      snapshotAt: 20,
    }),
  ]);
  expect(row.snapshotAt).toBe(20);

  delete row.snapshotAt;
  const unclocked = references.prepareDelivery(child, [prepareSessionAncestor(row)]);
  references.deliver(unclocked);
  expect(Object.hasOwn(row, "snapshotAt")).toBe(false);
  row.snapshotAt = 30;
  expect(
    references.prepareDelivery(child, [prepareSessionAncestor(row)]).ancestor?.ancestorSessionRefs,
  ).toBeUndefined();
});

it.each([
  { bound: "row count", count: 129, label: "ancestor", snapshotAt: 2 },
  { bound: "total content", count: 65, label: "a".repeat(2048), snapshotAt: 2 },
  { bound: "individual content", count: 1, label: "a".repeat(128 * 1024), snapshotAt: 3 },
])(
  "resends an ancestor in full after reaching the $bound bound",
  ({ count, label, snapshotAt }) => {
    const references = new ConnectionSessionRows();
    const rows = Array.from({ length: count }, (_, index): GatewaySessionRow => ({
      key: `agent:main:ancestor-${index}`,
      ...(count > 1 ? { sessionId: `ancestor-${index}` } : {}),
      kind: "direct",
      updatedAt: 1,
      snapshotAt: 2,
      label,
    }));
    for (const row of rows) {
      references.deliver(references.prepareDelivery(child, [prepareSessionAncestor(row)]));
    }

    if (count > 1) {
      expect(
        references.prepareDelivery(child, [prepareSessionAncestor(rows.at(-1)!)]).ancestor
          ?.ancestorSessionRefs,
      ).toEqual([expect.objectContaining({ key: rows.at(-1)!.key })]);
    }
    const row = { ...rows[0]!, snapshotAt };
    const evicted = references.prepareDelivery(child, [prepareSessionAncestor(row)]);
    expect(evicted.ancestor?.ancestorSessions).toEqual([expect.objectContaining(row)]);
    expect(evicted.ancestor?.ancestorSessionRefs).toBeUndefined();
  },
);
