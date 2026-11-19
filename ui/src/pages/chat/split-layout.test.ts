// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeChatSplitLayout } from "./split-layout-persistence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import {
  applyUiCommandToSplitLayout,
  closePane,
  findPane,
  insertPane,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  singlePaneLayout,
} from "./split-layout.ts";

const makePane = <Id extends string | number>(id: Id, sessionKey: string) => ({ id, sessionKey });
const makeColumn = <Id extends string | number>(
  id: string,
  panes: { id: Id; sessionKey: string }[],
  paneWeights: number[],
) => ({ id, panes, paneWeights });

function createSplitLayout(sessionKey = "main"): ChatSplitLayout {
  return insertPane(singlePaneLayout("c1", "p1", sessionKey), "p1", sessionKey, "right");
}

function threePaneLayout(): ChatSplitLayout {
  return insertPane(createSplitLayout(), "p2", "agent:main:second", "down");
}

function expectPair(weights: number[] | undefined, pair: [number, number], ...rest: number[]) {
  expect(weights).toEqual([expect.closeTo(pair[0]), expect.closeTo(pair[1]), ...rest]);
}

describe("chat split layout", () => {
  it.each(["up", "down"] as const)("inserts %s and halves only the target weight", (edge) => {
    const layout = insertPane(createSplitLayout(), "p1", edge, edge);
    const panes = [makePane("p1", "main"), makePane("p3", edge)];
    expect(layout.columns[0]?.panes).toEqual(edge === "up" ? panes.toReversed() : panes);
    expect(layout.columns[0]?.paneWeights).toEqual([0.5, 0.5]);
    expect(layout.activePaneId).toBe("p3");
  });

  it("closes panes, collapses columns, and chooses the specified adjacent active pane", () => {
    const layout = threePaneLayout();
    const previousInColumn = closePane(layout, "p3");
    expect(previousInColumn?.activePaneId).toBe("p2");
    expect(previousInColumn?.columns.at(1)?.paneWeights).toEqual([1]);

    const previousColumn = closePane(setActivePane(layout, "p2"), "p2");
    expect(previousColumn?.activePaneId).toBe("p1");
    expect(previousColumn?.columns.at(1)?.panes).toEqual([makePane("p3", "agent:main:second")]);

    const threeColumns = insertPane(createSplitLayout(), "p1", "third", "right");
    const collapsedColumn = closePane(threeColumns, "p3");
    expect(collapsedColumn?.columns.map((column) => column.id)).toEqual(["c1", "c2"]);
    expectPair(collapsedColumn?.columnWeights, [1 / 3, 2 / 3]);
    expect(collapsedColumn?.activePaneId).toBe("p1");

    expect(closePane(createSplitLayout(), "p1")).toBeUndefined();
  });

  it("maps UI split and focus commands without mutating the source layout", () => {
    const layout = createSplitLayout();
    const initial = setActivePane(setPaneSession(layout, "p2", "source"), "p1");
    expect(findPane(initial, "p2")?.pane.sessionKey).toBe("source");
    expect(initial.activePaneId).toBe("p1");
    expect(layout.columns.at(1)?.panes.at(0)?.sessionKey).toBe("main");
    expect(panesOf(layout)).not.toBe(layout.columns.at(0)?.panes);
    const split = applyUiCommandToSplitLayout(
      initial,
      { kind: "split", direction: "down", sessionKey: "agent:main:new" },
      "source",
    );
    expect(split && panesOf(split).map((pane) => pane.sessionKey)).toEqual([
      "main",
      "source",
      "agent:main:new",
    ]);
    expect(split?.activePaneId).toBe("p3");

    const focused = applyUiCommandToSplitLayout(split!, { kind: "focus", sessionKey: "main" });
    expect(focused?.activePaneId).toBe("p1");
  });

  it("resizes only a boundary pair and clamps each side to fifteen percent", () => {
    const layout = insertPane(createSplitLayout(), "p1", "third", "right");
    expectPair(resizeColumns(layout, 0, 0.8).columnWeights, [0.4, 0.1], 0.5);
    expectPair(resizeColumns(layout, 0, 0.99).columnWeights, [0.425, 0.075], 0.5);

    const panes = resizePanes(threePaneLayout(), "c2", 0, 0.2);
    expect(panes.columns.at(1)?.paneWeights).toEqual([0.2, 0.8]);
    expect(resizePanes(threePaneLayout(), "c2", 0, -1).columns.at(1)?.paneWeights).toEqual([
      0.15, 0.85,
    ]);
  });

  it("normalizes recoverable input and repairs weights, ids, and active pane", () => {
    expect(
      normalizeChatSplitLayout({
        columns: [
          makeColumn(
            "same",
            [makePane("same", " main "), makePane("same", " second "), makePane("empty", " ")],
            [2, 1, 1],
          ),
          makeColumn("same", [makePane(4, "third")], [0]),
        ],
        columnWeights: [0, 3],
        activePaneId: "missing",
      }),
    ).toEqual({
      columns: [
        makeColumn("same", [makePane("same", "main"), makePane("p1", "second")], [2 / 3, 1 / 3]),
        makeColumn("c1", [makePane("p2", "third")], [1]),
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "same",
    });
  });

  it.each([
    null,
    { columns: "no" },
    { columns: [] },
    { columns: [{ id: "c1", panes: [makePane("p1", " ")] }] },
    { columns: [{ id: "c1", panes: [makePane("p1", "main")] }] },
  ])("rejects unrecoverable layout %j", (layout) => {
    expect(normalizeChatSplitLayout(layout)).toBeUndefined();
  });

  it("retains layout identity when an operation changes nothing", () => {
    const layout = createSplitLayout();
    expect(insertPane(layout, "missing", "new", "right")).toBe(layout);
    expect(closePane(layout, "missing")).toBe(layout);
    expect(setPaneSession(layout, "missing", "new")).toBe(layout);
    expect(setPaneSession(layout, "p1", "main")).toBe(layout);
    expect(setActivePane(layout, "missing")).toBe(layout);
    expect(setActivePane(layout, layout.activePaneId)).toBe(layout);
    expect(resizeColumns(layout, 5, 0.2)).toBe(layout);
    expect(resizeColumns(layout, 0, 0.5)).toBe(layout);
    expect(resizePanes(layout, "missing", 0, 0.2)).toBe(layout);
    expect(resizePanes(layout, "c1", 0, 0.2)).toBe(layout);
  });

  it("keeps unchanged pane identities while editing frozen layouts", () => {
    const layout = threePaneLayout();
    for (const column of layout.columns) {
      column.panes.forEach(Object.freeze);
      Object.freeze(column.panes);
      Object.freeze(column.paneWeights);
      Object.freeze(column);
    }
    Object.freeze(layout.columns);
    Object.freeze(layout.columnWeights);
    Object.freeze(layout);

    const focused = setActivePane(layout, "p1");
    expect(focused.columns).toBe(layout.columns);
    const selected = setPaneSession(layout, "p2", "changed");
    expect(selected.columns[0]).toBe(layout.columns[0]);
    expect(selected.columns[1]?.panes[1]).toBe(layout.columns[1]?.panes[1]);
    expect(selected.columnWeights).toBe(layout.columnWeights);

    const inserted = insertPane(layout, "p2", "new", "down");
    expect(inserted.columns[0]).toBe(layout.columns[0]);
    expect(inserted.columns[1]?.panes[0]).toBe(layout.columns[1]?.panes[0]);
    expect(inserted.columnWeights).toBe(layout.columnWeights);
    const closed = closePane(layout, "p3");
    expect(closed?.columns[0]).toBe(layout.columns[0]);
    expect(closed?.columns[1]?.panes[0]).toBe(layout.columns[1]?.panes[0]);

    const columns = resizeColumns(layout, 0, 0.2);
    expect(columns.columns).toBe(layout.columns);
    const panes = resizePanes(layout, "c2", 0, 0.2);
    expect(panes.columns[0]).toBe(layout.columns[0]);
    expect(panes.columns[1]?.panes).toBe(layout.columns[1]?.panes);
    expect(panes.columnWeights).toBe(layout.columnWeights);
    expect(resizePanes(layout, "c2", 0, 0.5)).toBe(layout);
  });
});
