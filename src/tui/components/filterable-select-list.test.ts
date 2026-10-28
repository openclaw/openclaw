import { renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";
import { attacks, expectText, select, theme, typeText } from "./render.test-support.js";

const cursorCell = renderFakeCursor(" ");

const testItems: FilterableSelectItem[] = [
  { value: "session-1", label: "first session", description: "Oldest", searchText: "alpha" },
  { value: "session-2", label: "second session", description: "Newest", searchText: "beta" },
];

describe("FilterableSelectList", () => {
  const createList = (items = testItems, maxVisible = 5) =>
    new FilterableSelectList(items, maxVisible, theme);
  function expectFilter(list: FilterableSelectList, text = "") {
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(`>Filter: <> ${text}${cursorCell}`);
  }

  it("keeps ANSI, CJK, scroll, and no-match rows within seven terminal columns", () => {
    const items: FilterableSelectItem[] = [
      { value: "cjk", label: "\u001b[32m日本語検索\u001b[0m", description: "長い説明" },
      { value: "other", label: "another long search result" },
    ];
    const list = createList(items, 1);
    list.focused = true;

    for (const filter of ["", "missing"]) {
      typeText(list, filter);
      expect(Math.max(...list.render(7).map(visibleWidth))).toBeLessThanOrEqual(7);
    }
  });

  it("filters names beginning with k", () => {
    const list = createList(["alpha", "kilo", "juliet"].map((value) => ({ value, label: value })));

    list.handleInput("k");

    expectFilter(list, "k");
    expect(select(list)?.value).toBe("kilo");
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
      expect(select(list)?.value).toBe(value);
    }
  });

  it("resets the filtered selection when modifyOtherKeys Ctrl+C clears the query", () => {
    const list = createList();
    typeText(list, "beta");
    expectFilter(list, "beta");
    expect(select(list)?.value).toBe("session-2");
    list.handleInput("\x1b[27;5;99~");
    expectFilter(list);
    expect(select(list)?.value).toBe("session-1");
    expectText(list.render(80).join("\n"), ["first session", "second session"]);
  });

  it("sanitizes rendered fields without changing filtering or the selected value", () => {
    const rawValue = `fv-start${attacks[1]}fv-end\r\nمرحبا\tשלום`;
    const description = `fd-start${attacks[3]}fd-end\n東京`;
    const list = createList([
      { value: "decoy", label: "decoy" },
      { value: rawValue, label: attacks.join(""), description, searchText: "raw-filter-target" },
    ]);

    typeText(list, "raw-filter-target");
    const rendered = list.render(160).join("\n");

    expectText(
      rendered,
      ["fv-startfv-end", "مرحبا שלום", "fd-startfd-end 東京", "\u2067", "\u2069"],
      [...attacks, "fv-end\r\nمرحبا\tשלום"],
    );

    // Text removed from display remains part of the original search fields.
    list.handleInput("\x1b");
    typeText(list, "picker-title");
    expect(select(list)).toMatchObject({ searchText: "raw-filter-target", value: rawValue });
  });

  describe("scroll window", () => {
    const many: FilterableSelectItem[] = Array.from({ length: 20 }, (_, i) => ({
      value: `s-${i}`,
      label: `session-${String(i).padStart(2, "0")}`,
    }));
    const rows = (list: FilterableSelectList) =>
      list
        .render(80)
        .map((row) =>
          stripAnsi(row)
            .replace(/[*]/gu, "")
            .replace(/^[[]?[→ ]+[\]]?/u, "")
            .trim(),
        )
        .filter((row) => row.startsWith("session-"));
    const down = (list: FilterableSelectList, count: number) =>
      Array.from({ length: count }, () => list.handleInput("\u001b[B"));

    const createStableList = () => {
      const list = createList(many, 5);
      list.stableWindow = true;
      return list;
    };

    it("keeps the centered window outside screen reader mode", () => {
      const list = createList(many, 5);
      expect(rows(list)).toEqual([
        "session-00",
        "session-01",
        "session-02",
        "session-03",
        "session-04",
      ]);
      down(list, 3);
      expect(rows(list)).toEqual([
        "session-01",
        "session-02",
        "session-03",
        "session-04",
        "session-05",
      ]);
    });

    it("keeps visible rows still while the selection moves inside the window", () => {
      const list = createStableList();
      const first = rows(list);
      down(list, 4);
      expect(rows(list)).toEqual(first);
    });

    it("scrolls by one row only when the selection leaves the window", () => {
      const list = createStableList();
      rows(list);
      down(list, 5);
      expect(rows(list)).toEqual([
        "session-01",
        "session-02",
        "session-03",
        "session-04",
        "session-05",
      ]);
    });

    it("wraps from the first row to the last and back, as pi-tui's list does", () => {
      const list = createList(many, 5);
      rows(list);
      list.handleInput("\u001b[A");
      expect(select(list)?.value).toBe("s-19");
      list.handleInput("\u001b[B");
      expect(select(list)?.value).toBe("s-0");
    });

    it("ignores navigation when the filter matches nothing", () => {
      const list = createList(many, 5);
      typeText(list, "zzzzzzzzzz");
      list.handleInput("\u001b[B");
      list.handleInput("\u001b[A");
      const onSelect = vi.fn();
      list.onSelect = onSelect;
      list.handleInput("\r");
      expect(onSelect).not.toHaveBeenCalled();
      expect(() => list.render(80)).not.toThrow();
    });

    it("selects the highlighted entry after scrolling and after filtering", () => {
      const list = createList(many, 5);
      rows(list);
      down(list, 7);
      expect(select(list)?.value).toBe("s-7");
      typeText(list, "session-15");
      expect(select(list)?.value).toBe("s-15");
    });
  });
});
