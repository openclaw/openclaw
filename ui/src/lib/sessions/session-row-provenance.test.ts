// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createSessionRowProvenance,
  createSessionWriteObservation,
} from "./session-row-provenance.ts";

describe("session row provenance", () => {
  it.each([
    ["descriptor-first", "compact"],
    ["compact-first", "compact"],
    ["descriptor-first", "dashboard"],
    ["compact-first", "dashboard"],
  ] as const)(
    "retains detail facts across %s %s reads and lets full reads clear them",
    (order, rowMode) => {
      const provenance = createSessionRowProvenance();
      const identity = {
        key: "agent:main:details",
        sessionId: "details",
        kind: "direct" as const,
      };
      const descriptor: GatewaySessionRow = {
        ...identity,
        updatedAt: 100,
        snapshotAt: 100,
        label: "Before",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
        ...(rowMode === "dashboard" ? { model: "test-model", totalTokens: 123 } : {}),
      };
      const compact: GatewaySessionRow = {
        ...identity,
        rowMode,
        updatedAt: 200,
        snapshotAt: 200,
        label: "Current",
      };
      const reads: [GatewaySessionRow, GatewaySessionRow] =
        order === "descriptor-first" ? [descriptor, compact] : [compact, descriptor];
      provenance.observeReadRow(reads[0], 1);
      provenance.observeReadRow(reads[1], 2);
      const merged = provenance.mergeRow(reads[0], reads[1]);
      expect(merged).toMatchObject({
        label: "Current",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
        ...(rowMode === "dashboard" ? { model: "test-model", totalTokens: 123 } : {}),
      });

      const cleared: GatewaySessionRow = {
        ...identity,
        updatedAt: 300,
        snapshotAt: 300,
        label: "Current",
      };
      provenance.observeReadRow(cleared, 3);
      const next = provenance.mergeRow(merged, cleared);
      expect(next.thinkingLevels).toBeUndefined();
      expect(next.toolOverrides).toBeUndefined();
      expect(next.model).toBeUndefined();
      expect(next.totalTokens).toBeUndefined();
      expect(next.rowMode).toBeUndefined();
    },
  );

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

  it.each([
    { merged: [0, 1, 2] },
    { merged: [0, 2, 1] },
    { merged: [1, 0, 2] },
    { merged: [1, 2, 0] },
    { merged: [2, 0, 1] },
    { merged: [2, 1, 0] },
  ] as const)("orders sampled reads independently of merge order ($merged)", ({ merged }) => {
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
    for (const [index, row] of rows.entries()) {
      provenance.observeReadRow(row, index + 1, "main");
    }
    const result = merged.reduce<GatewaySessionRow>(
      (current, index) => provenance.mergeRow(current, rows[index]),
      rows[merged[0]],
    );
    expect(result.label).toBe("later descriptor");
    expect(provenance.rowRevision(result)).toBe(3);
  });

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
