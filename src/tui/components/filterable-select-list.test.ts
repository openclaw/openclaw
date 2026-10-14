// Filterable select list tests cover keyboard filtering and cursor behavior.
import { type SelectItem, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";

type FilterableSelectListTheme = ConstructorParameters<typeof FilterableSelectList>[2];

const mockTheme: FilterableSelectListTheme = {
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
  description: (t) => `(${t})`,
  scrollInfo: (t) => `~${t}~`,
  noMatch: (t) => `!${t}!`,
  filterLabel: (t) => `>${t}<`,
};

const testItems: FilterableSelectItem[] = [
  {
    value: "session-1",
    label: "first session",
    description: "Oldest",
    searchText: "alpha",
  },
  {
    value: "session-2",
    label: "second session",
    description: "Newest",
    searchText: "beta",
  },
];

describe("FilterableSelectList", () => {
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
    const width = 7;
    const items: FilterableSelectItem[] = [
      {
        value: "cjk",
        label: "\u001b[32m日本語の検索結果\u001b[0m",
        description: "長い説明と表示幅の検証",
      },
      { value: "other", label: "another long search result" },
    ];
    const list = new FilterableSelectList(items, 1, mockTheme);
    list.focused = true;

    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }

    typeInput(list, "missing");
    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("filters names beginning with k", () => {
    const list = new FilterableSelectList(
      [
        { value: "alpha", label: "alpha" },
        { value: "kilo", label: "kilo" },
        { value: "juliet", label: "juliet" },
      ],
      5,
      mockTheme,
    );

    list.handleInput("k");

    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(">Filter: <> k");
    expect(selectByEnter(list)?.value).toBe("kilo");
  });

  it("preserves arrow and Ctrl-key navigation", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);

    list.handleInput("\x1b[B");
    expect(selectByEnter(list)?.value).toBe("session-2");

    list.handleInput("\u0010");
    expect(selectByEnter(list)?.value).toBe("session-1");

    list.handleInput("\u000e");
    expect(selectByEnter(list)?.value).toBe("session-2");

    list.handleInput("\x1b[A");
    expect(selectByEnter(list)?.value).toBe("session-1");
  });

  it("clears the active filter before cancelling with modifyOtherKeys Ctrl+C", () => {
    const key = "\x1b[27;5;99~";
    const list = new FilterableSelectList(testItems, 5, mockTheme);
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };

    typeInput(list, "beta");
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(">Filter: <> beta");
    expect(selectByEnter(list)?.value).toBe("session-2");

    list.handleInput(key);

    expect(cancelled).toBe(false);
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(">Filter: <>");
    expect(selectByEnter(list)?.value).toBe("session-1");
    expect(list.render(80).join("\n")).toContain("first session");
    expect(list.render(80).join("\n")).toContain("second session");
    list.handleInput(key);
    expect(cancelled).toBe(true);
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
    const list = new FilterableSelectList(
      [
        { value: "decoy", label: "decoy" },
        {
          value: rawValue,
          label: attacks.join(""),
          description,
          searchText: "raw-filter-target",
        },
      ],
      5,
      mockTheme,
    );
    let selectedValue: string | undefined;
    let selectedItem: FilterableSelectItem | undefined;
    list.onSelect = (item) => {
      selectedValue = item.value;
      selectedItem = item;
    };

    typeInput(list, "raw-filter-target");
    const rendered = list.render(160).join("\n");

    expect(rendered).toContain("fv-startfv-end");
    expect(rendered).toContain("مرحبا שלום");
    expect(rendered).toContain("fd-startfd-end 東京");
    expect(rendered).toContain("\u2067");
    expect(rendered).toContain("\u2069");
    for (const attack of attacks) {
      expect(rendered).not.toContain(attack);
    }
    expect(rendered).not.toContain("fv-end\r\nمرحبا\tשלום");

    // Text removed from display remains part of the original search fields.
    list.handleInput("\x1b");
    typeInput(list, "filter-title");
    list.handleInput("\r");
    expect(selectedItem).toMatchObject({ searchText: "raw-filter-target" });
    expect(selectedValue).toBe(rawValue);
  });
});
