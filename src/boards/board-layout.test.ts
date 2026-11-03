import { expect, it, vi } from "vitest";
import * as board from "./board-layout.js";

type BoardLayout = Parameters<typeof board.normalizeBoardLayout>[0];
const layout = (): BoardLayout => ({
  tabs: [
    { tabId: "one", title: "One", position: 4, chatDock: "right" },
    { tabId: "two", title: "Two", position: 8, chatDock: "bottom" },
  ],
  widgets: [
    { name: "alpha", tabId: "one", position: 3 },
    { name: "beta", tabId: "one", position: 9 },
    { name: "gamma", tabId: "two", position: 2 },
  ].map((widget) =>
    Object.assign(widget, {
      contentKind: "html" as const,
      sizeW: 6,
      sizeH: 4,
      grantState: "none" as const,
      revision: 1,
    }),
  ),
});
const apply = (...ops: Parameters<typeof board.applyBoardOps>[1]) =>
  board.applyBoardOps(layout(), ops);
const findWidget = (state: BoardLayout, name = "alpha") =>
  state.widgets.find((w) => w.name === name)!;
function widgetOrder(state: BoardLayout, tabId: string): string[] {
  return state.widgets
    .filter((widget) => widget.tabId === tabId)
    .toSorted((a, b) => a.position - b.position)
    .map((widget) => widget.name);
}

it("sorts owned layouts without copying their arrays again", () => {
  const original = Object.assign(layout(), { revision: 99 });
  const copySort = vi.spyOn(Array.prototype, "toSorted");
  const ownedSort = vi.spyOn(Array.prototype, "sort");
  let copies: number;
  let sorts: number;
  try {
    board.normalizeBoardLayout(original);
    board.applyBoardOps(original, [
      { kind: "tab_update", tabId: "two", position: 0 },
      { kind: "widget_move", name: "alpha", tabId: "two", position: 0 },
      { kind: "tab_delete", tabId: "one" },
    ]);
    board.insertBoardWidget(original, { ...original.widgets[0]!, name: "new" }, { tabId: "two" });
    copies = copySort.mock.calls.length;
    sorts = ownedSort.mock.calls.length;
  } finally {
    copySort.mockRestore();
    ownedSort.mockRestore();
  }
  expect(copies).toBe(0);
  expect(sorts).toBeLessThanOrEqual(15);
});

it("keeps nested widget metadata caller-owned across layout operations", () => {
  const original = Object.assign(layout(), { revision: 99 });
  const widget = findWidget(original);
  widget.props = { series: [1, 2] };
  widget.declared = { tools: ["sessions"] };
  widget.declaredSummary = ["Tool access: sessions"];
  const before = structuredClone(original);
  const inserted = { ...widget, name: "inserted" };
  const emptyBatch = board.applyBoardOps(original, []);
  expect(emptyBatch.tabs.map((tab) => tab.position)).toEqual([0, 1]);
  expect(emptyBatch.widgets.map((item) => item.position)).toEqual([0, 1, 0]);
  const results = [
    board.normalizeBoardLayout(original),
    board.applyBoardOps(original, [
      { kind: "widget_resize", name: "alpha", sizeW: 2, sizeH: 3 },
      { kind: "widget_move", name: "alpha", position: 1 },
    ]),
    board.insertBoardWidget(original, inserted, { tabId: "two" }),
    emptyBatch,
  ];
  for (const result of results) {
    expect(Object.keys(result).toSorted()).toEqual(["tabs", "widgets"]);
    const copied = findWidget(result);
    copied.props!.series = [9];
    copied.declared!.tools!.push("usage");
    copied.declaredSummary!.push("changed");
    result.tabs[0]!.title = "changed";
  }
  findWidget(results[2]!, "inserted").declared!.tools!.push("cron");
  expect(original).toEqual(before);
});

it("reorders widgets by position and after anchors, including cross-tab moves", () => {
  const reordered = apply(
    { kind: "widget_move", name: "beta", position: 0 },
    { kind: "widget_move", name: "gamma", tabId: "one", after: "beta" },
  );
  expect(widgetOrder(reordered, "one")).toEqual(["beta", "gamma", "alpha"]);
  expect(widgetOrder(reordered, "two")).toEqual([]);
});

it("rejects missing and self after anchors", () => {
  const move = (after: string) => apply({ kind: "widget_move", name: "alpha", after });
  expect(() => move("missing")).toThrow(board.BoardValidationError);
  expect(() => move("alpha")).toThrow("after itself");
});

it("clamps widget sizes to the grid bounds", () => {
  const resized = apply({ kind: "widget_resize", name: "alpha", sizeW: 99, sizeH: -5 });
  expect(findWidget(resized)).toMatchObject({ sizeW: 12, sizeH: 1 });
});

it("moves deleted-tab widgets to the first remaining tab", () => {
  const next = apply({ kind: "tab_delete", tabId: "one" });
  expect(next.tabs).toMatchObject([{ tabId: "two" }]);
  expect(widgetOrder(next, "two")).toEqual(["gamma", "alpha", "beta"]);
});

it("allows deleting the last empty tab but rejects deleting it with widgets", () => {
  const state = layout();
  state.tabs = state.tabs.slice(0, 1);
  state.widgets = state.widgets.slice(0, 1);
  const remove = () => board.applyBoardOps(state, [{ kind: "tab_delete", tabId: "one" }]);
  expect(remove).toThrow("last board tab");
  state.widgets = [];
  expect(remove().tabs).toEqual([]);
});

it("requires tabs_reorder to be an exact permutation", () => {
  const reorder = (ids: string[]) => apply({ kind: "tabs_reorder", tabIds: ids });
  expect(reorder(["two", "one"]).tabs).toMatchObject([{ tabId: "two" }, { tabId: "one" }]);
  expect(() => reorder(["one", "one"])).toThrow("every tab exactly once");
});
