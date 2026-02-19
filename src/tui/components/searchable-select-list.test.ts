import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../../terminal/ansi.js";
import { SearchableSelectList, type SearchableSelectListTheme } from "./searchable-select-list.js";

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
  it("renders all items when no filter is applied", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    const output = list.render(80);

    // Should have search prompt line, spacer, and items
    expect(output.length).toBeGreaterThanOrEqual(3);
    expect(output[0]).toContain("search");
  });

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const longLabel = `session-${"x".repeat(40)}${tail}`; // > 30 chars; tail would be lost before PR
    const items = [{ value: longLabel, label: longLabel, description: "desc" }];
    const list = new SearchableSelectList(items, 5, mockTheme);

    const output = list.render(120).join("\n");
    expect(output).toContain(tail);
  });

  it("does not show description layout at width 40 (boundary)", () => {
    const items = [
      { value: "one", label: "one", description: "desc" },
      { value: "two", label: "two", description: "desc" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);
    list.setSelectedIndex(1); // ensure first row is not selected so description styling is applied

    const output = list.render(40).join("\n");
    expect(output).not.toContain("(desc)");
  });

  it("shows description layout at width 41 (boundary)", () => {
    const items = [
      { value: "one", label: "one", description: "desc" },
      { value: "two", label: "two", description: "desc" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);
    list.setSelectedIndex(1); // ensure first row is not selected so description styling is applied

    const output = list.render(41).join("\n");
    expect(output).toContain("(desc)");
  });

  it("keeps ANSI-highlighted description rows within terminal width", () => {
    const label = `provider/${"x".repeat(80)}`;
    const items = [
      { value: label, label, description: "Some description text that should not overflow" },
      { value: "other", label: "other", description: "Other description" },
    ];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);
    list.setSelectedIndex(1); // make first row non-selected so description styling is applied

    for (const ch of "provider") {
      list.handleInput(ch);
    }

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

    for (const ch of "32m") {
      list.handleInput(ch);
    }

    const output = list.render(80);
    expect(output.some((line) => line.includes("No matches"))).toBe(true);
  });

  it("does not corrupt ANSI sequences when highlighting multiple tokens", () => {
    const items = [{ value: "gpt-model", label: "gpt-model" }];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);

    for (const ch of "gpt m") {
      list.handleInput(ch);
    }

    const renderedLine = list.render(80).find((line) => stripAnsi(line).includes("gpt-model"));
    expect(renderedLine).toBeDefined();
    const highlightOpens = renderedLine ? renderedLine.split("\u001b[31m").length - 1 : 0;
    expect(highlightOpens).toBe(2);
  });

  it("filters items when typing", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gemini" - unique enough to narrow down
    list.handleInput("g");
    list.handleInput("e");
    list.handleInput("m");
    list.handleInput("i");
    list.handleInput("n");
    list.handleInput("i");

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("google/gemini-pro");
  });

  it("prioritizes exact substring matches over fuzzy matches", () => {
    // Add items where one has early exact match, others are fuzzy or late matches
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

    // Type "opus" - should match "opus-direct" first (earliest exact substring)
    for (const ch of "opus") {
      list.handleInput(ch);
    }

    // First result should be "opus-direct" where "opus" appears at position 0
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("opus-direct");
  });

  it("keeps exact label matches ahead of description matches", () => {
    const longPrefix = "x".repeat(250);
    const items = [
      { value: "late-label", label: `${longPrefix}opus`, description: "late exact match" },
      { value: "desc-first", label: "provider/other", description: "opus in description" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    for (const ch of "opus") {
      list.handleInput(ch);
    }

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("late-label");
  });

  it("exact label match beats description match", () => {
    const items = [
      {
        value: "provider/other",
        label: "provider/other",
        description: "This mentions opus in description",
      },
      { value: "provider/opus-model", label: "provider/opus-model", description: "Something else" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    for (const ch of "opus") {
      list.handleInput(ch);
    }

    // Label match should win over description match
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("provider/opus-model");
  });

  it("orders description matches by earliest index", () => {
    const items = [
      { value: "first", label: "first", description: "prefix opus value" },
      { value: "second", label: "second", description: "opus suffix value" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    for (const ch of "opus") {
      list.handleInput(ch);
    }

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("second");
  });

  it("filters items with fuzzy matching", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gpt" which should match openai/gpt-4 models
    list.handleInput("g");
    list.handleInput("p");
    list.handleInput("t");

    const selected = list.getSelectedItem();
    expect(selected?.value).toContain("gpt");
  });

  it("preserves fuzzy ranking when only fuzzy matches exist", () => {
    const items = [
      { value: "xg---4", label: "xg---4", description: "Worse fuzzy match" },
      { value: "gpt-4", label: "gpt-4", description: "Better fuzzy match" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    for (const ch of "g4") {
      list.handleInput(ch);
    }

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("gpt-4");
  });

  it("highlights matches in rendered output", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    for (const ch of "gpt") {
      list.handleInput(ch);
    }

    const output = list.render(80).join("\n");
    expect(output).toContain("*gpt*");
  });

  it("shows no match message when filter yields no results", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Type something that won't match
    list.handleInput("x");
    list.handleInput("y");
    list.handleInput("z");

    const output = list.render(80);
    expect(output.some((line) => line.includes("No matches"))).toBe(true);
  });

  it("navigates with arrow keys", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Initially first item is selected
    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-opus");

    // Press down arrow (escape sequence for down arrow)
    list.handleInput("\x1b[B");

    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-sonnet");
  });

  it("calls onSelect when enter is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let selectedValue: string | undefined;

    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    // Press enter
    list.handleInput("\r");

    expect(selectedValue).toBe("anthropic/claude-3-opus");
  });

  it("calls onCancel when escape is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let cancelled = false;

    list.onCancel = () => {
      cancelled = true;
    };

    // Press escape
    list.handleInput("\x1b");

    expect(cancelled).toBe(true);
  });
});
