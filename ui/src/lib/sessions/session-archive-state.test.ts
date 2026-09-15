// @vitest-environment node
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

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
