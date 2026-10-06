// @vitest-environment node
import { describe, expect, it } from "vitest";
import { childSessionListQuery, fetchChildSessionRows } from "./child-session-data.ts";
import { createSessionDeletionHarness } from "./session-deletion.test-support.ts";

describe("optimistic deletion and child-list pagination", () => {
  it("treats a complete server window with a locally hidden row as complete", async () => {
    const h = createSessionDeletionHarness();
    const parentKey = "agent:main:parent";
    const query = childSessionListQuery(parentKey);
    try {
      await h.sessions.refreshList(query);
      // Keep the delete response pending so the overlay is the only thing
      // hiding the row; the server window still reports all three.
      void h.sessions.delete(h.alpha.key, {
        expectedSessionId: h.alpha.sessionId,
      });
      const snapshot = h.sessions.listSnapshot(query).result;
      expect(snapshot?.sessions).toHaveLength(2);
      expect(snapshot?.totalCount).toBe(3);
      expect(snapshot?.hasMore ?? false).toBe(false);
      const listsBefore = h.request.mock.calls.filter(([method]) => method === "sessions.list");
      // Regression: this threw "The child session list kept changing. Try
      // again." after four reads of the unchanged roster.
      const rows = await fetchChildSessionRows({
        sessions: h.sessions,
        parentKey,
        isCurrent: () => true,
      });
      expect(rows?.map((row) => row.key)).toEqual([h.beta.key, h.sibling.key]);
      const listsAfter = h.request.mock.calls.filter(([method]) => method === "sessions.list");
      expect(listsAfter.length - listsBefore.length).toBe(1);
    } finally {
      h.responses.get(h.alpha.key)?.resolve({ deleted: false });
      h.sessions.dispose();
    }
  });
});
