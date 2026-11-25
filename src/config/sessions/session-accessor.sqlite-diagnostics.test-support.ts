import assert from "node:assert/strict";
import { preparedSharingReads } from "./session-accessor.sqlite-entry-cache-publication-state.js";

export function assertNoRetainedSessionSharingReads(): void {
  const retained = [...preparedSharingReads.values()].reduce(
    (count, reads) => count + reads.size,
    0,
  );
  assert.equal(retained, 0, "Completed handlers must release retained session sharing facts");
}
