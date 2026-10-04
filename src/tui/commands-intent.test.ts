// Tests for keyword slash command discovery in OpenClaw TUI.
import { describe, expect, it } from "vitest";
import { matchSlashKeywords } from "./commands-intent.js";
import { createTuiAutocompleteProvider } from "./tui-autocomplete.js";

describe("matchSlashKeywords", () => {
  it("matches keywords to canonical commands", () => {
    const tokenMatches = matchSlashKeywords("token");
    expect(tokenMatches.some((m) => m.command === "usage")).toBe(true);

    const pricingMatches = matchSlashKeywords("pricing");
    expect(pricingMatches.some((m) => m.command === "usage")).toBe(true);

    const switchMatches = matchSlashKeywords("switch");
    expect(switchMatches.some((m) => m.command === "model")).toBe(true);
  });

  it("ranks exact tag matches ahead of prefix and substring matches", () => {
    const matches = matchSlashKeywords("spend");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.command).toBe("usage");
    expect(matches[0]?.score).toBe(100);
  });

  it("filters suggestions using availableCommands when provided", () => {
    const onlyModel = new Set(["model"]);
    const tokenMatches = matchSlashKeywords("token", onlyModel);
    expect(tokenMatches).toEqual([]);

    const switchMatches = matchSlashKeywords("switch", onlyModel);
    expect(switchMatches.length).toBe(1);
    expect(switchMatches[0]?.command).toBe("model");
  });

  it("returns empty array for short words", () => {
    expect(matchSlashKeywords("a")).toEqual([]);
    expect(matchSlashKeywords("")).toEqual([]);
  });
});

describe("createTuiAutocompleteProvider keyword discovery", () => {
  it("discovers slash commands from keyword tags on slash-prefixed input", async () => {
    const commands = [
      { name: "usage", description: "Toggle per-response usage line or show cost summary" },
      { name: "model", description: "Set model (or open picker)" },
      { name: "reset", description: "Reset the current session" },
    ];
    const provider = createTuiAutocompleteProvider(commands, process.cwd());
    const suggestions = await provider.getSuggestions(["/pricing"], 0, 8, {
      signal: new AbortController().signal,
    });

    expect(suggestions).not.toBeNull();
    const usageItem = suggestions?.items.find((it) => it.value === "usage");
    expect(usageItem).toBeDefined();
    expect(usageItem?.label).toBe("/usage");

    // Verify applyCompletion contract uses bare command value and produces exactly '/usage ' without '//'
    const applied = provider.applyCompletion(["/pricing"], 0, 8, usageItem!, suggestions!.prefix);
    expect(applied).toEqual({
      cursorCol: "/usage ".length,
      cursorLine: 0,
      lines: ["/usage "],
    });
  });

  it("maps restart keyword to reset command", async () => {
    const commands = [{ name: "reset", description: "Reset the current session" }];
    const provider = createTuiAutocompleteProvider(commands, process.cwd());
    const suggestions = await provider.getSuggestions(["/restart"], 0, 8, {
      signal: new AbortController().signal,
    });

    expect(suggestions).not.toBeNull();
    const resetItem = suggestions?.items.find((it) => it.value === "reset");
    expect(resetItem).toBeDefined();
  });

  it("preserves regular draft typing and does not hijack ordinary text", async () => {
    const commands = [{ name: "help", description: "Show slash command help" }];
    const provider = createTuiAutocompleteProvider(commands, process.cwd());
    // Regular conversational typing without leading slash must return null
    const natural = await provider.getSuggestions(["help me edit ./src/"], 0, 19, {
      signal: new AbortController().signal,
    });
    expect(natural).toBeNull();
  });
});
