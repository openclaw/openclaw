// Searchable select list tests cover filtering and selection behavior.
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  SearchableSelectList,
  type SearchableSelectItem,
  type SearchableSelectListTheme,
} from "./searchable-select-list.js";

const mockTheme: SearchableSelectListTheme = {
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
  description: (t) => `(${t})`,
  scrollInfo: (t) => `~${t}~`,
  noMatch: (t) => `!${t}!`,
  searchPrompt: (t) => `>${t}<`,
  searchInput: (t) => `|${t}|`,
  matchHighlight: (t) => `*${t}*`,
};

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

const testItems = [
  {
    value: "anthropic/claude-3-opus",
    label: "anthropic/claude-3-opus",
    description: "Claude 3 Opus",
  },
  {
    value: "anthropic/claude-3-sonnet",
    label: "anthropic/claude-3-sonnet",
    description: "Claude 3 Sonnet",
  },
  { value: "openai/gpt-4", label: "openai/gpt-4", description: "GPT-4" },
  { value: "openai/gpt-4-turbo", label: "openai/gpt-4-turbo", description: "GPT-4 Turbo" },
  { value: "google/gemini-pro", label: "google/gemini-pro", description: "Gemini Pro" },
];

describe("SearchableSelectList", () => {
  it("keeps replacement empty-state errors on one safe terminal row", () => {
    const list = new SearchableSelectList([], 7, ansiHighlightTheme);
    list.setItems([], "network\nunavailable\u001b[2J");
    expect(list.render(80).at(-1)).toBe("  network unavailable");
  });

  function selectByEnter(list: SearchableSelectList) {
    const onSelect = vi.fn<(item: SearchableSelectItem) => void>();
    list.onSelect = onSelect;
    list.handleInput("\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    return onSelect.mock.calls[0]?.[0];
  }

  function typeInput(list: SearchableSelectList, text: string) {
    for (const ch of text) {
      list.handleInput(ch);
    }
  }

  it("emits the hardware cursor marker only while the search input is focused", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    expect(list.focused).toBe(false);
    expect(list.render(80)[0]).not.toContain(CURSOR_MARKER);

    list.focused = true;
    expect(list.focused).toBe(true);
    expect(list.render(80)[0]).toContain(CURSOR_MARKER);

    list.focused = false;
    expect(list.focused).toBe(false);
    expect(list.render(80)[0]).not.toContain(CURSOR_MARKER);
  });

  it("keeps ANSI, CJK, scroll, and no-match rows within seven terminal columns", () => {
    const width = 7;
    const items = [
      {
        value: "cjk",
        label: "\u001b[32m日本語の検索結果\u001b[0m",
        description: "長い説明と表示幅の検証",
      },
      { value: "other", label: "another long search result" },
    ];
    const list = new SearchableSelectList(items, 1, ansiHighlightTheme);
    list.focused = true;

    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }

    list.handleInput("missing");
    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const longLabel = `session-${"x".repeat(40)}${tail}`; // > 30 chars; tail would be lost before PR
    const items = [{ value: longLabel, label: longLabel, description: "desc" }];
    const list = new SearchableSelectList(items, 5, mockTheme);

    const output = list.render(120).join("\n");
    expect(output).toContain(tail);
  });

  it("omits the description layout at width 40", () => {
    const list = new SearchableSelectList(
      [
        { value: "one", label: "one", description: "desc" },
        { value: "two", label: "two", description: "desc" },
      ],
      5,
      mockTheme,
    );
    // Use the non-selected description's style to observe the layout boundary.
    list.handleInput("\x1b[B");
    expect(list.render(40).join("\n")).not.toContain("(desc)");
  });

  it("does not corrupt ANSI sequences when highlighting repeated query tokens", () => {
    const items = [{ value: "gpt-model", label: "gpt-model" }];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);

    typeInput(list, "  gpt GPT m  ");

    const rendered = list.render(80);
    const renderedLine = rendered.find((line) => stripAnsi(line).includes("gpt-model"));
    if (!renderedLine) {
      throw new Error("expected rendered gpt-model line");
    }
    const highlightOpens = renderedLine.split("\u001b[31m").length - 1;
    expect(highlightOpens).toBe(2);
    expect(list.render(80)).toEqual(rendered);
  });

  it("renders the current query after clearing and replacing it", () => {
    const list = new SearchableSelectList(
      [{ value: "match", label: "alpha beta", description: "alpha beta description" }],
      5,
      ansiHighlightTheme,
    );
    list.handleInput("alpha");
    list.render(80);
    list.handleInput("\u0015");
    const cleared = list.render(80).join("\n");
    list.handleInput("beta");
    const replaced = list.render(80).join("\n");

    expect(cleared).not.toContain("\u001b[31m");
    expect(replaced.split("alpha \u001b[31mbeta\u001b[0m")).toHaveLength(3);
    expect(list.render(80).join("\n")).toBe(replaced);
  });

  it("sanitizes rendered fields before applying trusted highlighting", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;search-title\u0007",
      "\u001b]52;c;search-clipboard\u0007",
      "\u009b2K",
      "\u009d0;search-c1-title\u009c",
    ];
    const rawValue = `selector-value-start${attacks[1]}selector-value-end\r\nمرحبا\tשלום`;
    const description = `selector-description-start${attacks[3]}selector-description-end\n東京`;
    const list = new SearchableSelectList(
      [
        {
          value: rawValue,
          label: attacks.join(""),
          description,
          searchText: "selector-target",
        },
      ],
      5,
      ansiHighlightTheme,
    );
    let selectedValue: string | undefined;
    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    typeInput(list, "selector");
    const rendered = list.render(160).join("\n");
    const plainRendered = stripAnsi(rendered);

    expect(rendered).toContain("\u001b[31mselector\u001b[0m-value-start");
    expect(plainRendered).toContain("selector-description-startselector-description-end 東京");
    expect(plainRendered).toContain("مرحبا שלום");
    expect(plainRendered).toContain("\u2067");
    expect(plainRendered).toContain("\u2069");
    for (const attack of attacks) {
      expect(rendered).not.toContain(attack);
    }
    expect(rendered).not.toContain("selector-value-end\r\nمرحبا\tשלום");

    list.handleInput("\r");
    expect(selectedValue).toBe(rawValue);
  });

  it("cancels an active query with modifyOtherKeys Ctrl+C", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let cancelled = false;

    list.onCancel = () => {
      cancelled = true;
    };

    typeInput(list, "gemini");
    const selected = selectByEnter(list);
    list.handleInput("\x1b[27;5;99~");

    expect(cancelled).toBe(true);
    expect(selectByEnter(list)).toBe(selected);
  });
});
