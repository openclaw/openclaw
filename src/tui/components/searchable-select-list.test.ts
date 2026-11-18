import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { attacks, expectText, select, theme, typeText } from "./render.test-support.js";
import {
  SearchableSelectList,
  type SearchableSelectItem,
  type SearchableSelectListTheme,
} from "./searchable-select-list.js";

const ansiHighlightTheme: SearchableSelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
  searchPrompt: (t) => t,
  searchInput: (t) => t,
  matchHighlight: (t) => `\u001b[31m${t}\u001b[0m`,
};

function item(value: string, description?: string, label = value): SearchableSelectItem {
  return { value, label, description };
}
const makeList = (
  items: SearchableSelectItem[] = [item("model")],
  listTheme: SearchableSelectListTheme = theme,
  maxVisible = 5,
) => new SearchableSelectList(items, maxVisible, listTheme);
const makeAnsiList = (items: SearchableSelectItem[], maxVisible = 5) =>
  makeList(items, ansiHighlightTheme, maxVisible);
const render = (list: SearchableSelectList, width = 80) => list.render(width).join("\n");

describe("SearchableSelectList", () => {
  it.each(["label", "description", "searchText"] as const)(
    "matches canonical Unicode in %s without changing the value",
    (field) => {
      for (const [stored, query] of [
        ["Café".normalize("NFD"), "Café"],
        ["Café", "Café".normalize("NFD")],
      ] as const) {
        const value = "original-value";
        const list = makeList([{ value, label: "model", [field]: stored }]);
        typeText(list, query);
        expect(select(list)?.value).toBe(value);
      }
    },
  );

  it("keeps replacement empty-state errors on one safe terminal row", () => {
    const list = makeAnsiList([], 7);
    list.setItems([], "network\nunavailable\u001b[2J");
    expect(list.render(80).at(-1)).toBe("  network unavailable");
  });

  it("emits the hardware cursor marker only while the search input is focused", () => {
    const list = makeList();
    expect(list.focused).toBe(false);
    for (const focused of [false, true, false]) {
      list.focused = focused;
      expect(list.render(80)[0]?.includes(CURSOR_MARKER)).toBe(focused);
    }
  });

  it("keeps ANSI, CJK, scroll, and no-match rows within seven terminal columns", () => {
    const width = 7;
    const list = makeAnsiList(
      [
        item("cjk", "長い説明と表示幅の検証", "\u001b[32m日本語の検索結果\u001b[0m"),
        item("other", undefined, "another long search result"),
      ],
      1,
    );
    list.focused = true;
    expect(list.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    list.handleInput("missing");
    expect(list.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const list = makeList([item(`session-${"x".repeat(40)}${tail}`, "desc")]);
    expect(render(list, 120)).toContain(tail);
  });

  it("omits the description layout at width 40", () => {
    const list = makeList([item("one", "desc"), item("two", "desc")]);
    // Use the non-selected description's style to observe the layout boundary.
    list.handleInput("\x1b[B");
    expect(render(list, 40)).not.toContain("(desc)");
  });

  it("does not corrupt ANSI sequences when highlighting repeated query tokens", () => {
    const list = makeAnsiList([item("gpt-model")]);
    typeText(list, "  gpt GPT m  ");
    const rendered = list.render(80);
    const renderedLine = rendered.find((line) => stripAnsi(line).includes("gpt-model"));
    expect(renderedLine?.split("\u001b[31m")).toHaveLength(3);
  });

  it("renders the current query after clearing and replacing it", () => {
    const list = makeAnsiList([item("match", "alpha beta description", "alpha beta")]);
    list.handleInput("alpha");
    list.render(80);
    list.handleInput("\u0015");
    const cleared = render(list);
    list.handleInput("beta");
    const replaced = render(list);
    expect(cleared).not.toContain("\u001b[31m");
    expect(replaced.split("alpha \u001b[31mbeta\u001b[0m")).toHaveLength(3);
    expect(render(list)).toBe(replaced);
  });

  it("sanitizes rendered fields before applying trusted highlighting", () => {
    const rawValue = `selector-value-start${attacks[1]}selector-value-end\r\nمرحبا\tשלום`;
    const description = `selector-description-start${attacks[3]}selector-description-end\n東京`;
    const list = makeAnsiList([
      { value: rawValue, label: attacks.join(""), description, searchText: "selector-target" },
    ]);
    typeText(list, "selector");
    const rendered = render(list, 160);
    const plainRendered = stripAnsi(rendered);
    expect(rendered).toContain("\u001b[31mselector\u001b[0m-value-start");
    expectText(plainRendered, [
      "selector-description-startselector-description-end 東京",
      "مرحبا שלום",
      "\u2067",
      "\u2069",
    ]);
    expectText(rendered, [], [...attacks, "selector-value-end\r\nمرحبا\tשלום"]);
    expect(select(list)?.value).toBe(rawValue);
  });
});
