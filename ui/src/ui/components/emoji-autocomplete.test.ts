import { describe, expect, it } from "vitest";
import { searchEmoji } from "../emoji-data.ts";
import {
  extractEmojiQuery,
  updateEmojiAutocomplete,
  applyEmojiSelection,
  createEmojiAutocompleteState,
  handleEmojiKeydown,
} from "./emoji-autocomplete.ts";

describe("searchEmoji", () => {
  it("returns matches for a prefix", () => {
    const results = searchEmoji("rock");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].shortcode).toBe("rocket");
    expect(results[0].emoji).toBe("🚀");
  });

  it("returns at most `limit` results", () => {
    const results = searchEmoji("s", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("returns empty for empty query", () => {
    expect(searchEmoji("")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const results = searchEmoji("FIRE");
    expect(results.some((r) => r.shortcode === "fire")).toBe(true);
  });

  it("includes substring matches after prefix matches", () => {
    const results = searchEmoji("sun", 10);
    const codes = results.map((r) => r.shortcode);
    // "sun_with_face" and "sunflower" are prefix matches
    // "sunglasses" is a prefix match
    expect(codes).toContain("sunflower");
    expect(codes).toContain("sunglasses");
  });

  it("returns results for common shortcodes", () => {
    expect(searchEmoji("heart").length).toBeGreaterThan(0);
    expect(searchEmoji("thumbsup")[0].emoji).toBe("👍");
    expect(searchEmoji("fire")[0].emoji).toBe("🔥");
    expect(searchEmoji("wave")[0].emoji).toBe("👋");
    expect(searchEmoji("eyes")[0].emoji).toBe("👀");
  });
});

describe("extractEmojiQuery", () => {
  it("extracts query after colon (2+ chars)", () => {
    expect(extractEmojiQuery(":smi", 4)).toBe("smi");
  });

  it("returns null for single char after colon (below 2-char minimum)", () => {
    expect(extractEmojiQuery(":s", 2)).toBeNull();
  });

  it("extracts query after colon with preceding text", () => {
    expect(extractEmojiQuery("hello :rock", 11)).toBe("rock");
  });

  it("returns null when no colon present", () => {
    expect(extractEmojiQuery("hello", 5)).toBeNull();
  });

  it("returns null when colon is not preceded by whitespace", () => {
    expect(extractEmojiQuery("abc:def", 7)).toBeNull();
  });

  it("returns null for empty query after colon", () => {
    expect(extractEmojiQuery(":", 1)).toBeNull();
  });

  it("returns null when query contains a space", () => {
    expect(extractEmojiQuery(":smi le", 7)).toBeNull();
  });

  it("returns null when there is a closing colon (completed shortcode)", () => {
    // After typing :smile: the cursor is after the second colon,
    // so lastIndexOf(':') finds the second colon, and query is empty
    expect(extractEmojiQuery(":smile:", 7)).toBeNull();
  });

  it("works at start of text", () => {
    expect(extractEmojiQuery(":fi", 3)).toBe("fi");
  });

  it("works with newlines before colon", () => {
    expect(extractEmojiQuery("line1\n:wa", 9)).toBe("wa");
  });
});

describe("updateEmojiAutocomplete", () => {
  it("opens with results when query matches", () => {
    const state = updateEmojiAutocomplete(":rock", 5);
    expect(state.open).toBe(true);
    expect(state.results.length).toBeGreaterThan(0);
    expect(state.selectedIndex).toBe(0);
  });

  it("stays closed when no match", () => {
    const state = updateEmojiAutocomplete(":zzzzqqqq", 9);
    expect(state.open).toBe(false);
  });

  it("stays closed without colon", () => {
    const state = updateEmojiAutocomplete("hello", 5);
    expect(state.open).toBe(false);
  });
});

describe("applyEmojiSelection", () => {
  it("replaces :shortcode with emoji", () => {
    const result = applyEmojiSelection(":rock", 5, "🚀");
    expect(result.text).toBe("🚀");
    expect(result.cursor).toBe("🚀".length);
  });

  it("preserves text before and after", () => {
    const result = applyEmojiSelection("hey :fi more", 4 + 3, "🔥");
    expect(result.text).toBe("hey 🔥 more");
  });

  it("returns unchanged text when no query", () => {
    const result = applyEmojiSelection("hello", 5, "🔥");
    expect(result.text).toBe("hello");
  });
});

describe("handleEmojiKeydown", () => {
  function makeState(overrides: Partial<ReturnType<typeof createEmojiAutocompleteState>> = {}) {
    return {
      ...createEmojiAutocompleteState(),
      open: true,
      results: [
        { shortcode: "rocket", emoji: "🚀" },
        { shortcode: "fire", emoji: "🔥" },
        { shortcode: "heart", emoji: "❤️" },
      ],
      ...overrides,
    };
  }

  it("returns false when closed", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
    const result = handleEmojiKeydown(
      event,
      createEmojiAutocompleteState(),
      () => {},
      () => {},
    );
    expect(result).toBe(false);
  });

  it("moves selection down on ArrowDown", () => {
    let updated: ReturnType<typeof createEmojiAutocompleteState> | null = null;
    const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
    handleEmojiKeydown(
      event,
      makeState({ selectedIndex: 0 }),
      (s) => (updated = s),
      () => {},
    );
    expect(updated!.selectedIndex).toBe(1);
  });

  it("wraps around on ArrowDown at end", () => {
    let updated: ReturnType<typeof createEmojiAutocompleteState> | null = null;
    const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
    handleEmojiKeydown(
      event,
      makeState({ selectedIndex: 2 }),
      (s) => (updated = s),
      () => {},
    );
    expect(updated!.selectedIndex).toBe(0);
  });

  it("moves selection up on ArrowUp", () => {
    let updated: ReturnType<typeof createEmojiAutocompleteState> | null = null;
    const event = new KeyboardEvent("keydown", { key: "ArrowUp" });
    handleEmojiKeydown(
      event,
      makeState({ selectedIndex: 1 }),
      (s) => (updated = s),
      () => {},
    );
    expect(updated!.selectedIndex).toBe(0);
  });

  it("selects emoji on Enter", () => {
    let selected: string | null = null;
    const event = new KeyboardEvent("keydown", { key: "Enter" });
    const result = handleEmojiKeydown(
      event,
      makeState({ selectedIndex: 1 }),
      () => {},
      (emoji) => (selected = emoji),
    );
    expect(result).toBe(true);
    expect(selected).toBe("🔥");
  });

  it("selects emoji on Tab", () => {
    let selected: string | null = null;
    const event = new KeyboardEvent("keydown", { key: "Tab" });
    handleEmojiKeydown(
      event,
      makeState({ selectedIndex: 0 }),
      () => {},
      (emoji) => (selected = emoji),
    );
    expect(selected).toBe("🚀");
  });

  it("closes on Escape", () => {
    let updated: ReturnType<typeof createEmojiAutocompleteState> | null = null;
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    handleEmojiKeydown(
      event,
      makeState(),
      (s) => (updated = s),
      () => {},
    );
    expect(updated!.open).toBe(false);
  });
});
