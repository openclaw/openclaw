// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

it.each([
  { pending: false, archived: undefined, publishedId: "same", expected: undefined },
  { pending: false, archived: false, publishedId: "same", expected: undefined },
  { pending: true, archived: undefined, publishedId: null, expected: "pending" },
  { pending: false, archived: true, publishedId: null, expected: "archived" },
  { pending: false, archived: true, publishedId: "replacement", expected: undefined },
  { pending: false, archived: true, publishedId: undefined, expected: undefined },
  { pending: true, archived: true, publishedId: "same", expected: "pending" },
  { pending: true, archived: false, publishedId: "same", expected: "pending" },
])(
  "resolves visibility with pending=$pending archived=$archived publishedId=$publishedId",
  ({ pending, archived, publishedId, expected }) => {
    const row: GatewaySessionRow = {
      key: "agent:main:archive-visibility",
      sessionId: "same",
      kind: "direct",
    };
    const provenance = createSessionRowProvenance();
    const publishedRow = vi.fn(() =>
      publishedId === null ? undefined : { ...row, sessionId: publishedId },
    );
    const archives = createSessionArchiveState(publishedRow, () => {}, provenance);
    if (archived !== undefined) {
      provenance.observeReadRow(row, 1);
      archives.observe(row.key, archived, row);
    }
    if (pending) {
      archives.beginPending(row.key, row.sessionId);
    }
    expect(archives.visibility(` ${row.key} `)).toBe(expected);
    if (!pending && !archived) {
      for (const key of [row.key, "agent:main:unknown", " "]) {
        expect(archives.visibility(key)).toBeUndefined();
      }
      expect(publishedRow).not.toHaveBeenCalled();
    }
  },
);

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

it("keeps a confirmed archive until a newer authoritative archive observation", () => {
  const row: GatewaySessionRow = {
    key: "agent:main:confirmed-archive",
    sessionId: "confirmed-archive",
    kind: "direct",
    archived: false,
    updatedAt: 1,
  };
  const provenance = createSessionRowProvenance();
  const archives = createSessionArchiveState(
    () => row,
    () => {},
    provenance,
  );
  provenance.observeReadRow(row, 1);
  archives.observe(row.key, false, row);
  archives.confirm(row.key, true, { sessionId: "confirmed-archive", updatedAt: 2 });

  const unrelated = { ...row, label: "Updated title", updatedAt: 3 };
  provenance.observeReadRow(unrelated, 3);
  expect(archives.applyRow(unrelated).archived).toBe(true);

  const pendingRead = { ...row };
  provenance.observeReadRow(pendingRead, 2);
  archives.observe(row.key, false, pendingRead);
  expect(archives.applyRow(pendingRead).archived).toBe(true);

  const freshRead = { ...row, updatedAt: 4 };
  provenance.observeReadRow(freshRead, 4);
  archives.observe(row.key, false, freshRead);
  expect(archives.applyRow(freshRead).archived).toBe(false);
});
