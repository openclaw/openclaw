// @vitest-environment node
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import {
  createSessionRowProvenance,
  createSessionWriteObservation,
  mergeSessionFieldObservations,
} from "./session-row-provenance.ts";

it("keeps a successor's archive pending when an older same-key archive confirms", () => {
  const previous: GatewaySessionRow = {
    key: "agent:main:archive-replacement",
    sessionId: "previous",
    kind: "direct",
  };
  let published = previous;
  const provenance = createSessionRowProvenance();
  const archives = createSessionArchiveState(
    () => published,
    () => {},
    provenance,
  );
  const finishPrevious = archives.beginPending(previous.key, previous.sessionId);
  published = { ...previous, sessionId: "successor" };
  expect(archives.visibility(previous.key)).toBeUndefined();
  const finishSuccessor = archives.beginPending(published.key, published.sessionId);

  provenance.observeReadRow(previous, 1);
  archives.observe(previous.key, true, previous);
  finishPrevious?.();
  expect(archives.visibility(published.key)).toBe("pending");

  provenance.observeReadRow(published, 2);
  archives.observe(published.key, true, published);
  expect(archives.visibility(published.key)).toBe("archived");
  finishSuccessor?.();
  expect(archives.visibility(published.key)).toBe("archived");
});

it.each([false, true])(
  "preserves writer ancestry through split archive observations (archived=%s)",
  (archived) => {
    const initial = {
      key: "agent:main:archive-projection",
      sessionId: "archive-projection",
      kind: "direct",
      updatedAt: 10,
      label: "initial",
      archived,
      pinned: !archived,
      ...(archived ? {} : { pinnedAt: 10 }),
    } satisfies GatewaySessionRow;
    const provenance = createSessionRowProvenance();
    provenance.observeReadRow(initial, 1);
    const observationRow = provenance.inheritRow({ ...initial, updatedAt: 20 }, initial);
    provenance.observeFields(observationRow, ["archived"], createSessionWriteObservation(2, 20));
    const row = provenance.inheritRow({ ...observationRow }, observationRow);
    provenance.mergeRow(observationRow, observationRow);
    const confirmation = provenance.fieldObservation(observationRow, "archived");
    expect(confirmation.writer).toBe(confirmation.source);
    const archives = createSessionArchiveState(
      () => initial,
      () => {},
      provenance,
    );
    archives.observe(observationRow.key, archived, observationRow);
    const projected = archives.applyRow(row);
    expect(projected).toBe(row);
    expect(projected.archived).toBe(archived);
    expect(projected.pinned).toBe(!archived);
    const split = provenance.fieldObservation(projected, "archived");
    expect(split).not.toBe(confirmation);
    expect(split.source).toBe(confirmation.source);
    expect(split.writer).toBe(confirmation.writer);

    const omittedField = archived ? "pinnedAt" : "archivedAt";
    const explicitUndefined = provenance.inheritRow(
      { ...projected, [omittedField]: undefined },
      projected,
    );
    expect(provenance.fieldObservation(explicitUndefined, omittedField)).toBe(confirmation);
    const retainedUndefined = archives.applyRow(explicitUndefined);
    expect(retainedUndefined).toBe(explicitUndefined);
    expect(retainedUndefined).toHaveProperty(omittedField, undefined);

    const olderField = provenance.inheritRow({ ...explicitUndefined }, explicitUndefined);
    provenance.observeFields(
      olderField,
      [omittedField],
      provenance.fieldObservation(initial, omittedField),
    );
    expect(archives.applyRow(olderField)).not.toHaveProperty(omittedField);

    const event = provenance.inheritRow({ ...projected, label: "writer" }, projected);
    provenance.observeFields(event, ["label"], createSessionWriteObservation(3, 20));
    expect(provenance.fieldObservation(event, "label").writer).toBeUndefined();
    expect(provenance.fieldObservation(event, "archived")).toBe(split);
    const expectedFields = archived
      ? { archived: true, pinned: false, pinnedAt: undefined }
      : {
          archived: false,
          archivedAt: undefined,
          archivedBy: undefined,
          archiveReason: undefined,
        };
    const values: Record<string, unknown> = event;
    for (const [name, value] of Object.entries(expectedFields)) {
      expect(values[name]).toBe(value);
      expect(Object.hasOwn(values, name)).toBe(value !== undefined);
      const observed = provenance.fieldObservation(event, name);
      expect(mergeSessionFieldObservations(observed, confirmation).observation).toBe(observed);
    }

    const applied = archives.applyRow(event);
    expect(applied).toBe(event);
    expect.soft(provenance.fieldObservation(applied, "label").writer?.revision).toBe(3);
    const read = { ...applied, label: "read" };
    const selectRead = provenance.observeReadRow(read, 4, "main", [applied]);
    const current = provenance.mergeRow(applied, read);
    expect(current.label).toBe("read");
    const olderAck = provenance.inheritRow({ ...initial, label: "older acknowledgement" }, initial);
    provenance.observeFields(olderAck, ["label"], createSessionWriteObservation(2, null, 5));
    const retained = provenance.mergeRow(current, olderAck);
    expect(retained.label).toBe("read");
    expect(selectRead(retained, ["label"])).toEqual(["label"]);
    expect(retained.archived).toBe(archived);
    expect(retained.pinned).toBe(!archived);
  },
);
