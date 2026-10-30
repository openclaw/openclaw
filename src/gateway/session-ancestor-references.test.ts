import { expect, it } from "vitest";
import { prepareSessionAncestor, ConnectionSessionRows } from "./session-ancestor-references.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const child: GatewaySessionRow = { key: "agent:main:child", kind: "direct", updatedAt: 1 };
const parent = { ...child, key: "agent:main:parent", sessionId: "parent" };
const prepare = (owner: ConnectionSessionRows, row: GatewaySessionRow) =>
  owner.prepareDelivery(child, [prepareSessionAncestor(row)]);

it("shares certified ancestor rows across histories only within their publication revision", () => {
  const row = Object.freeze({ ...parent, snapshotAt: 10 });
  const prepared = [prepareSessionAncestor(row)];
  const first = new ConnectionSessionRows();
  const second = new ConnectionSessionRows();
  const revisionA = "00000000-0000-4000-8000-000000000001";
  const revisionB = "00000000-0000-4000-8000-000000000002";
  const publish = (owner: ConnectionSessionRows, revision: typeof revisionA | typeof revisionB) =>
    owner.prepareDelivery(child, prepared, revision).ancestor!.ancestorSessions[0]!;
  const initial = publish(first, revisionA);
  expect(publish(second, revisionA)).toBe(initial);
  expect(initial).toEqual({ ...row, ancestorRevision: revisionA });
  const next = publish(first, revisionB);
  expect(next).not.toBe(initial);
  expect(next).toEqual({ ...row, ancestorRevision: revisionB });
  expect(publish(second, revisionB)).toBe(next);
  expect(publish(first, revisionA)).toEqual(initial);
  expect(initial.ancestorRevision).toBe(revisionA);
});

it("preserves presentation clocks and the delivered baseline when serialization fails", () => {
  const references = new ConnectionSessionRows();
  const row: GatewaySessionRow = { ...parent, snapshotAt: 10, label: "Parent" };
  const first = prepare(references, row);
  references.deliver(first);
  const firstAncestor = first.ancestor?.ancestorSessions[0];
  expect(firstAncestor?.snapshotAt).toBe(10);
  expect(row.snapshotAt).toBe(10);

  row.snapshotAt = 20;
  Object.defineProperty(row, "label", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("presentation unavailable");
    },
  });
  expect(() => prepare(references, row)).toThrow("presentation unavailable");
  expect(row.snapshotAt).toBe(20);
  Object.defineProperty(row, "label", { value: "Parent" });
  const next = prepare(references, row);
  expect(next.ancestor?.ancestorSessions).toEqual([]);
  expect(next.ancestor?.ancestorSessionRefs).toEqual([
    expect.objectContaining({ revision: firstAncestor?.ancestorRevision, snapshotAt: 20 }),
  ]);
  expect(row.snapshotAt).toBe(20);

  delete row.snapshotAt;
  references.deliver(prepare(references, row));
  expect(Object.hasOwn(row, "snapshotAt")).toBe(false);
  row.snapshotAt = 30;
  expect(prepare(references, row).ancestor?.ancestorSessionRefs).toBeUndefined();
});

it.each([
  { bound: "row count", count: 129, label: "ancestor", snapshotAt: 2 },
  { bound: "total content", count: 65, label: "a".repeat(2048), snapshotAt: 2 },
  { bound: "individual content", count: 1, label: "a".repeat(128 * 1024), snapshotAt: 3 },
])("resends full ancestors after the $bound retention limit", ({ count, label, snapshotAt }) => {
  const references = new ConnectionSessionRows();
  const rows = Array.from({ length: count }, (_, index): GatewaySessionRow => ({
    ...child,
    key: `agent:main:ancestor-${index}`,
    ...(count > 1 ? { sessionId: `ancestor-${index}` } : {}),
    snapshotAt: 2,
    label,
  }));
  for (const row of rows) {
    references.deliver(prepare(references, row));
  }

  if (count > 1) {
    expect(prepare(references, rows.at(-1)!).ancestor?.ancestorSessionRefs).toEqual([
      expect.objectContaining({ key: rows.at(-1)!.key }),
    ]);
  }
  const row = { ...rows[0]!, snapshotAt };
  const evicted = prepare(references, row);
  expect(evicted.ancestor?.ancestorSessions).toEqual([expect.objectContaining(row)]);
  expect(evicted.ancestor?.ancestorSessionRefs).toBeUndefined();
});
