// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createSessionRowProvenance,
  createSessionWriteObservation,
} from "./session-row-provenance.ts";

describe("session row provenance", () => {
  it("isolates donated field receipts from the source and other inherited rows", () => {
    const provenance = createSessionRowProvenance();
    const source: GatewaySessionRow = {
      key: "agent:main:inherited",
      sessionId: "inherited",
      kind: "direct",
      derivedTitle: "Source title",
      label: "Source label",
    };
    const donor = { ...source, derivedTitle: "Donated title" };
    const donorFields = provenance.observeReadRow(donor, 1);
    const sourceFields = provenance.observeReadRow(source, 2);
    const sibling = provenance.inheritRow({ ...source }, source);
    const enriched = provenance.inheritRow(
      { ...source, derivedTitle: donor.derivedTitle },
      source,
      donor,
    );

    expect(donorFields(enriched, ["derivedTitle", "label"])).toEqual(["derivedTitle"]);
    expect(sourceFields(enriched, ["derivedTitle", "label"])).toEqual(["label"]);
    for (const row of [source, sibling]) {
      expect(sourceFields(row, ["derivedTitle", "label"])).toEqual(["derivedTitle", "label"]);
    }

    const eventFields = provenance.observeFields(
      enriched,
      ["derivedTitle"],
      createSessionWriteObservation(3, 20),
    );
    provenance.observeFields(source, ["label"], createSessionWriteObservation(4, 30));
    expect(eventFields(enriched, ["derivedTitle"])).toEqual(["derivedTitle"]);
    expect(donorFields(donor, ["derivedTitle"])).toEqual(["derivedTitle"]);
    expect(donorFields(enriched, ["derivedTitle"])).toEqual([]);
    expect(sourceFields(source, ["derivedTitle", "label"])).toEqual(["derivedTitle"]);
    expect(sourceFields(sibling, ["derivedTitle", "label"])).toEqual(["derivedTitle", "label"]);
    expect(sourceFields(enriched, ["derivedTitle", "label"])).toEqual(["label"]);
  });

  it("advances read freshness without replacing unchanged presentation rows", () => {
    const provenance = createSessionRowProvenance();
    const initial: GatewaySessionRow = {
      key: "agent:main:unchanged",
      sessionId: "unchanged",
      kind: "direct",
      label: "Current",
      snapshotAt: 100,
    };
    const fresh = { ...initial, snapshotAt: 200 };
    provenance.observeReadRow(initial, 1);
    provenance.observeReadRow(fresh, 2);
    const projected = provenance.mergeRow(initial, fresh);
    expect(projected).toBe(initial);
    expect(provenance.fieldObservation(projected, "label").source.snapshotAt).toBe(200);
    const stale = { ...initial, label: "Stale", snapshotAt: 150 };
    provenance.observeReadRow(stale, 3);
    expect(provenance.mergeRow(projected, stale)).toBe(projected);
    expect(projected.label).toBe("Current");
  });

  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const;
  it.each(orders.flatMap((observed) => orders.map((merged) => ({ observed, merged }))))(
    "orders sampled reads independently of completion and merge order ($observed / $merged)",
    ({ observed, merged }) => {
      const provenance = createSessionRowProvenance();
      const base: GatewaySessionRow = {
        key: "agent:main:mixed-reads",
        sessionId: "mixed-reads",
        kind: "direct",
        updatedAt: 10,
      };
      const rows = [
        { ...base, label: "fresh list", snapshotAt: 200 },
        { ...base, label: "later descriptor", snapshotAt: 250 },
        { ...base, label: "cached old list", snapshotAt: 100 },
      ] as const;
      for (const index of observed) {
        provenance.observeReadRow(rows[index], index + 1, "main");
      }
      const result = merged.reduce<GatewaySessionRow>(
        (current, index) => provenance.mergeRow(current, rows[index]),
        rows[merged[0]],
      );
      expect(result.label).toBe("later descriptor");
      expect(provenance.rowRevision(result)).toBe(3);
    },
  );

  it("retains fallback ownership when a self-projection materializes an unobserved row", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = { key: "global", sessionId: "session", kind: "global" };
    const donor = { ...row };
    provenance.observeReadRow(donor, 2, "home");

    expect(provenance.rowRevision(row)).toBe(0);
    expect(provenance.hasObservation(row)).toBe(false);
    expect(provenance.hasNewerFacts(row, -1)).toBe(true);
    expect(provenance.hasNewerFacts(row, 0)).toBe(false);
    expect(provenance.mergeRow(row, row, "work")).toBe(row);
    provenance.inheritRow(row, donor);
    expect(provenance.owner(row)).toBe("work");
    expect(provenance.hasObservation(row)).toBe(false);

    provenance.reset();
    expect(provenance.owner(row)).toBeNull();
    provenance.mergeRow(row, row, "new-owner");
    expect(provenance.owner(row)).toBe("new-owner");
  });

  it("preserves read and event field receipts across self-projection and retires them on reset", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = {
      key: "global",
      sessionId: "session",
      kind: "global",
      updatedAt: 1,
      label: "initial",
    };
    const readFields = provenance.observeReadRow(row, 1, "work");
    provenance.mergeRow(row, row, "work");
    provenance.mergeRow(row, row, "work");
    row.label = "updated";
    const eventFields = provenance.observeFields(
      row,
      ["label"],
      createSessionWriteObservation(2, 2),
      "work",
    );
    delete row.updatedAt;

    expect(provenance.mergeRow(row, row, "other")).toBe(row);
    expect(provenance.owner(row)).toBe("work");
    expect(readFields(row, ["label", "updatedAt"])).toEqual(["updatedAt"]);
    expect(eventFields(row, ["label", "updatedAt"])).toEqual(["label"]);
    expect(provenance.rowRevision(row)).toBe(1);
    expect(provenance.hasObservation(row)).toBe(true);
    expect(provenance.hasNewerFacts(row, 1)).toBe(true);
    expect(provenance.hasNewerFacts(row, 2)).toBe(false);

    provenance.reset();
    expect(readFields(row, ["updatedAt"])).toEqual([]);
    expect(eventFields(row, ["label"])).toEqual([]);
    expect(provenance.rowRevision(row)).toBe(0);
    expect(provenance.hasObservation(row)).toBe(false);
  });

  it("admits a writer after an invalid self-merge gains a valid identity", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = {
      key: "global",
      agentId: "work",
      sessionId: "",
      kind: "global",
      label: "writer",
    };
    provenance.observeReadRow(row, 1, "work");
    provenance.observeFields(row, ["label"], createSessionWriteObservation(2, 2));
    provenance.mergeRow(row, row);
    provenance.mergeRow(row, row);
    expect(provenance.fieldObservation(row, "label").writer).toBeUndefined();
    row.sessionId = "repaired";
    expect(provenance.mergeRow(row, row)).toBe(row);
    expect(provenance.fieldObservation(row, "label").writer?.revision).toBe(2);
    expect(row.label).toBe("writer");
  });

  it.each([
    { name: "key", patch: { key: "agent:other:session" }, owner: "other" },
    { name: "agent", patch: { agentId: "other" }, owner: "other" },
    { name: "incarnation", patch: { sessionId: "replacement" }, owner: "work" },
    { name: "invalid identity", patch: { sessionId: "" }, owner: "work" },
  ])(
    "keeps same-object values and source selection correct after a $name change",
    ({ patch, owner }) => {
      const provenance = createSessionRowProvenance();
      const row: GatewaySessionRow = {
        key: "global",
        agentId: "work",
        sessionId: "original",
        kind: "global",
        label: "writer",
        updatedAt: 2,
      };
      provenance.observeReadRow(row, 1, "work");
      const select = provenance.observeFields(row, ["label"], createSessionWriteObservation(2, 2));
      provenance.mergeRow(row, row);
      provenance.mergeRow(row, row);
      expect(select(row, ["label"])).toEqual(["label"]);
      Object.assign(row, patch, { label: "local value" });
      expect(provenance.mergeRow(row, row, "unrelated")).toBe(row);
      expect(row.label).toBe("local value");
      expect(provenance.owner(row)).toBe(owner);
      expect(select(row, ["label"])).toEqual([]);
      expect(provenance.fieldObservation(row, "label").writer?.revision).toBe(2);
    },
  );

  it.each([
    { admission: "merged", sameReadRow: false },
    { admission: "self-projected", sameReadRow: false },
    { admission: "self-projected", sameReadRow: true },
  ])(
    "keeps $admission writer ancestry across a newer read (same row: $sameReadRow)",
    ({ admission, sameReadRow }) => {
      const provenance = createSessionRowProvenance();
      const initial: GatewaySessionRow = {
        key: "agent:main:provenance",
        sessionId: "provenance",
        kind: "direct",
        updatedAt: 10,
        label: "initial",
      };
      provenance.observeReadRow(initial, 1);
      const event = { ...initial, updatedAt: 20, label: "writer" };
      provenance.inheritRow(event, initial);
      provenance.mergeRow(event, event);
      provenance.observeFields(event, ["label"], createSessionWriteObservation(3, 20));
      const accepted = provenance.mergeRow(admission === "self-projected" ? event : initial, event);
      provenance.mergeRow(accepted, accepted);
      const predecessor = provenance.inheritRow({ ...accepted }, accepted);
      const read = sameReadRow
        ? Object.assign(accepted, { updatedAt: 20, label: "read" })
        : { ...initial, updatedAt: 20, label: "read" };
      const selectRead = provenance.observeReadRow(read, 4, "main", [predecessor]);
      provenance.mergeRow(read, read);
      provenance.mergeRow(read, read);
      const projected = provenance.mergeRow(accepted, read);
      expect(projected.label).toBe("read");
      expect(selectRead(projected, ["label"])).toEqual(["label"]);

      const olderAck = { ...initial, label: "older acknowledgement" };
      provenance.inheritRow(olderAck, initial);
      provenance.observeFields(olderAck, ["label"], createSessionWriteObservation(2, null, 5));
      const retained = provenance.mergeRow(projected, olderAck);
      expect(retained.label).toBe("read");
      expect(selectRead(retained, ["label"])).toEqual(["label"]);
      expect(provenance.rowRevision(retained)).toBe(4);

      const stale = { ...read, updatedAt: 10, label: "stale event" };
      provenance.inheritRow(stale, read);
      provenance.observeFields(stale, ["label"], createSessionWriteObservation(6, 10));
      const afterStale = provenance.mergeRow(retained, stale);
      expect(afterStale.label).toBe("read");
      const newerAck = { ...initial, label: "newer acknowledgement" };
      provenance.inheritRow(newerAck, initial);
      provenance.observeFields(newerAck, ["label"], createSessionWriteObservation(5, null, 7));
      expect(provenance.mergeRow(afterStale, newerAck).label).toBe("newer acknowledgement");
    },
  );
});
