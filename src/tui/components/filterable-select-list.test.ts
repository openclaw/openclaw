import { renderFakeCursor, type SelectItem, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";

const mockTheme = {
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
  description: (t) => `(${t})`,
  scrollInfo: (t) => `~${t}~`,
  noMatch: (t) => `!${t}!`,
  filterLabel: (t) => `>${t}<`,
} satisfies ConstructorParameters<typeof FilterableSelectList>[2];

const cursorCell = renderFakeCursor(" ");

const testItems: FilterableSelectItem[] = [
  { value: "session-1", label: "first session", description: "Oldest", searchText: "alpha" },
  { value: "session-2", label: "second session", description: "Newest", searchText: "beta" },
];

describe("FilterableSelectList", () => {
  const createList = (items = testItems, maxVisible = 5) =>
    new FilterableSelectList(items, maxVisible, mockTheme);
  function expectFilter(list: FilterableSelectList, text = "") {
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(`>Filter: <> ${text}${cursorCell}`);
  }
  function selectByEnter(list: FilterableSelectList) {
    const onSelect = vi.fn<(item: SelectItem) => void>();
    list.onSelect = onSelect;
    list.handleInput("\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    return onSelect.mock.calls[0]?.[0];
  }

  function typeInput(list: FilterableSelectList, text: string) {
    for (const ch of text) {
      list.handleInput(ch);
    }
  }

  it("keeps ANSI, CJK, scroll, and no-match rows within seven terminal columns", () => {
    const items: FilterableSelectItem[] = [
      { value: "cjk", label: "\u001b[32m日本語検索\u001b[0m", description: "長い説明" },
      { value: "other", label: "another long search result" },
    ];
    const list = createList(items, 1);
    list.focused = true;

    for (const filter of ["", "missing"]) {
      typeInput(list, filter);
      expect(Math.max(...list.render(7).map(visibleWidth))).toBeLessThanOrEqual(7);
    }
  });

  it("filters names beginning with k", () => {
    const list = createList(["alpha", "kilo", "juliet"].map((value) => ({ value, label: value })));

    list.handleInput("k");

    expectFilter(list, "k");
    expect(selectByEnter(list)?.value).toBe("kilo");
  });

  it("preserves arrow and Ctrl-key navigation", () => {
    const list = createList();

    for (const [key, value] of [
      ["\x1b[B", "session-2"],
      ["\u0010", "session-1"],
      ["\u000e", "session-2"],
      ["\x1b[A", "session-1"],
    ] as const) {
      list.handleInput(key);
      expect(selectByEnter(list)?.value).toBe(value);
    }
  });

  it("clears the active filter before cancelling with modifyOtherKeys Ctrl+C", () => {
    const key = "\x1b[27;5;99~";
    const list = createList();
    const onCancel = vi.fn();
    list.onCancel = onCancel;

    typeInput(list, "beta");
    expectFilter(list, "beta");
    expect(selectByEnter(list)?.value).toBe("session-2");

    list.handleInput(key);

    expect(onCancel).not.toHaveBeenCalled();
    expectFilter(list);
    expect(selectByEnter(list)?.value).toBe("session-1");
    expect(list.render(80).join("\n")).toContain("first session");
    expect(list.render(80).join("\n")).toContain("second session");
    list.handleInput(key);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("sanitizes rendered fields without changing filtering or the selected value", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;filter-title\u0007",
      "\u001b]52;c;filter-clipboard\u0007",
      "\u009b2K",
      "\u009d0;filter-c1-title\u009c",
    ];
    const rawValue = `fv-start${attacks[1]}fv-end\r\nمرحبا\tשלום`;
    const description = `fd-start${attacks[3]}fd-end\n東京`;
    const list = createList([
      { value: "decoy", label: "decoy" },
      { value: rawValue, label: attacks.join(""), description, searchText: "raw-filter-target" },
    ]);

    typeInput(list, "raw-filter-target");
    const rendered = list.render(160).join("\n");

    expect(rendered).toContain("fv-startfv-end");
    expect(rendered).toContain("مرحبا שלום");
    expect(rendered).toContain("fd-startfd-end 東京");
    expect(rendered).toContain("\u2067");
    expect(rendered).toContain("\u2069");
    for (const attack of [...attacks, "fv-end\r\nمرحبا\tשלום"]) {
      expect(rendered).not.toContain(attack);
    }

    // Text removed from display remains part of the original search fields.
    list.handleInput("\x1b");
    typeInput(list, "filter-title");
    expect(selectByEnter(list)).toMatchObject({ searchText: "raw-filter-target", value: rawValue });
  });
});
