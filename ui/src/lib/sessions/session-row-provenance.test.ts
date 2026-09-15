// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createSessionRowProvenance,
  createSessionWriteObservation,
} from "./session-row-provenance.ts";

describe("session row provenance", () => {
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

  it.each(["merged", "self-projected"])(
    "keeps %s writer ancestry without changing the source of a newer read",
    (admission) => {
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
      provenance.observeFields(event, ["label"], createSessionWriteObservation(3, 20));
      const accepted = provenance.mergeRow(admission === "self-projected" ? event : initial, event);
      const read = { ...initial, updatedAt: 20, label: "read" };
      const selectRead = provenance.observeReadRow(read, 4, "main", [accepted]);
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
