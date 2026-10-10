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

  function expectSelectedValueForQuery(
    list: SearchableSelectList,
    query: string,
    expectedValue: string,
  ) {
    typeInput(list, query);
    const selected = selectByEnter(list);
    expect(selected?.value).toBe(expectedValue);
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

  it.each([0, 1, 2, 7, 12])(
    "keeps ANSI, CJK, scroll, and no-match rows within %i terminal columns",
    (width) => {
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
    },
  );

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const longLabel = `session-${"x".repeat(40)}${tail}`; // > 30 chars; tail would be lost before PR
    const items = [{ value: longLabel, label: longLabel, description: "desc" }];
    const list = new SearchableSelectList(items, 5, mockTheme);

    const output = list.render(120).join("\n");
    expect(output).toContain(tail);
  });

  it.each([
    { width: 40, visible: false },
    { width: 41, visible: true },
  ])("renders description layout at width $width: $visible", ({ width, visible }) => {
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
    expect(list.render(width).join("\n").includes("(desc)")).toBe(visible);
  });

  it("keeps ANSI-highlighted description rows within terminal width", () => {
    const label = `provider/${"x".repeat(80)}`;
    const items = [
      { value: label, label, description: "Some description text that should not overflow" },
      { value: "other", label: "other", description: "Other description" },
    ];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);
    typeInput(list, "provider");

    const width = 80;
    const output = list.render(width);
    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("ignores ANSI escape codes in search matching", () => {
    const items = [
      { value: "styled", label: "\u001b[32mopenai/gpt-4\u001b[0m", description: "Styled label" },
      { value: "plain", label: "plain-item", description: "Plain label" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "32m");
    expect(list.render(80).join("\n")).toContain("No matches");
  });

  it.each(["gpt m", "  gpt GPT m  "])(
    "does not corrupt ANSI sequences when highlighting query %j",
    (query) => {
      const items = [{ value: "gpt-model", label: "gpt-model" }];
      const list = new SearchableSelectList(items, 5, ansiHighlightTheme);

      typeInput(list, query);

      const rendered = list.render(80);
      const renderedLine = rendered.find((line) => stripAnsi(line).includes("gpt-model"));
      if (!renderedLine) {
        throw new Error("expected rendered gpt-model line");
      }
      const highlightOpens = renderedLine.split("\u001b[31m").length - 1;
      expect(highlightOpens).toBe(2);
      expect(list.render(80)).toEqual(rendered);
    },
  );

  it("prioritizes exact substring matches over fuzzy matches", () => {
    const items = [
      { value: "openrouter/auto", label: "openrouter/auto", description: "Routes to best" },
      { value: "opus-direct", label: "opus-direct", description: "Direct opus model" },
      {
        value: "anthropic/claude-3-opus",
        label: "anthropic/claude-3-opus",
        description: "Claude 3 Opus",
      },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "opus");

    // First result should be "opus-direct" where "opus" appears at position 0
    const selected = selectByEnter(list);
    expect(selected?.value).toBe("opus-direct");
  });

  it("keeps exact label matches ahead of description matches", () => {
    const longPrefix = "x".repeat(250);
    const items = [
      { value: "late-label", label: `${longPrefix}opus`, description: "late exact match" },
      { value: "desc-first", label: "provider/other", description: "opus in description" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "late-label");
  });

  it("orders description matches by earliest index", () => {
    const items = [
      { value: "first", label: "first", description: "prefix opus value" },
      { value: "second", label: "second", description: "opus suffix value" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "second");
  });

  it("treats slashes as fuzzy token separators", () => {
    const list = new SearchableSelectList(
      [{ value: "sonnet", label: "Claude Sonnet", description: "anthropic" }],
      5,
      mockTheme,
    );

    expectSelectedValueForQuery(list, "anthropic/sonnet", "sonnet");
  });

  it("preserves fuzzy ranking when only fuzzy matches exist", () => {
    const items = [
      { value: "xg---4", label: "xg---4", description: "Worse fuzzy match" },
      { value: "gpt-4", label: "gpt-4", description: "Better fuzzy match" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "g4");

    const selected = selectByEnter(list);
    expect(selected?.value).toBe("gpt-4");
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

  it("navigates with arrow keys", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Initially first item is selected
    expect(selectByEnter(list)?.value).toBe("anthropic/claude-3-opus");

    list.handleInput("\x1b[B");

    expect(selectByEnter(list)?.value).toBe("anthropic/claude-3-sonnet");
  });

  it.each([
    { query: "j", expectedValue: "juliet" },
    { query: "k", expectedValue: "kilo" },
  ])("filters names beginning with $query", ({ query, expectedValue }) => {
    const list = new SearchableSelectList(
      [
        { value: "alpha", label: "alpha" },
        { value: "kilo", label: "kilo" },
        { value: "juliet", label: "juliet" },
      ],
      5,
      mockTheme,
    );

    list.handleInput(query);

    expect(selectByEnter(list)?.value).toBe(expectedValue);
    expect(stripAnsi(list.render(80)[0] ?? "")).toContain(query);
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

  it.each([
    { name: "Escape", key: "\x1b" },
    { name: "Ctrl+C", key: "\u0003" },
    { name: "Kitty Ctrl+C", key: "\x1b[99;5u" },
    { name: "modifyOtherKeys Ctrl+C", key: "\x1b[27;5;99~" },
  ])("cancels an active query with $name", ({ key }) => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let cancelled = false;

    list.onCancel = () => {
      cancelled = true;
    };

    typeInput(list, "gemini");
    const selected = selectByEnter(list);
    list.handleInput(key);

    expect(cancelled).toBe(true);
    expect(selectByEnter(list)).toBe(selected);
  });
});
