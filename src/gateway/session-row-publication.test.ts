import { expect, it, vi } from "vitest";
import { create as createRow } from "./session-row-projection-record.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { prepareSessionRowPublicationView } from "./session-row-publication.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("retires only affected row vectors, preserves witnesses, and releases selections once", () => {
  const revisions = createSessionRowProjectionRevisions(new Map(), new Map());
  const projection = {
    state: { cfg: {}, revision: {}, rowContext: {} },
    onSelectionChange: revisions.onSelectionChange,
    onFactsChange: revisions.onFactsChange,
  } as SessionRowProjection;
  const read = prepareSessionRowPublicationView(projection);
  const { lists } = read();
  const row = (key: string): GatewaySessionRow => ({ key, kind: "direct", updatedAt: 1 });
  const selection = {
    entries: [],
    totalCount: 0,
    ownerFacet: [],
    ownerCount: 0,
    offset: 0,
    nextOffset: null,
    hasMore: false,
  };
  let unrelatedReads = 0;
  const cold = {
    ...row("cold"),
    get key() {
      unrelatedReads++;
      return "cold";
    },
  };
  const vectors = [[row("hot"), cold], [row("hot")], [cold]];
  const views = vectors.map((rows, index) => {
    const view = lists.get(String(index));
    lists.setRows(view, rows, true);
    view.selection = selection;
    lists.update(view);
    return view;
  });
  const changed = createRow(
    {
      key: "hot",
      agentId: "main",
      storeTarget: { agentId: "main", storePath: "/synthetic/store" },
    },
    { sessionId: "hot", updatedAt: 2 },
  );
  try {
    revisions.publishSelection(changed, false, false);
    expect(views.map((view) => lists.get(view.key).selection)).toEqual([
      selection,
      selection,
      selection,
    ]);
    revisions.publishFacts({ key: "hot" });
    expect(views.map((view) => view.rows)).toEqual([undefined, undefined, vectors[2]]);
    expect(views.map((view) => view.rowHistory?.length ?? 0)).toEqual([1, 1, 0]);
    unrelatedReads = 0;
    for (let index = 0; index < 100; index++) {
      revisions.publishFacts({ key: "hot" });
    }
    expect(unrelatedReads).toBe(0);
    revisions.publishSelection(changed);
    expect(views.map((view) => view.selection)).toEqual([undefined, undefined, undefined]);
    const update = vi.spyOn(lists, "update");
    for (let index = 0; index < 100; index++) {
      revisions.publishSelection(changed);
    }
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    expect(views[2]!.rows).toBe(vectors[2]);
    // Replacing membership must remove the old key, including duplicate aliases.
    lists.setRows(views[0]!, [row("other"), row("other")], true);
    revisions.publishFacts({ key: "hot" });
    expect(views[0]!.rows).toHaveLength(2);
    revisions.publishFacts({ key: "other" });
    expect(views[0]!.rows).toBeUndefined();
    revisions.publishFacts();
    expect(views.map((view) => view.rows)).toEqual([undefined, undefined, undefined]);
    expect(views[2]!.rowHistory).toHaveLength(1);
    read();
    // Revision-only invalidation also runs before a retained selection can be read.
    lists.get("2").selection = selection;
    lists.update(views[2]!);
    projection.state.revision = {};
    read();
    expect(lists.get("2").selection).toBeUndefined();
    revisions.publishSelection();
    expect([...lists.values()]).toHaveLength(0);
  } finally {
    lists.clear();
    revisions.dispose();
  }
});
