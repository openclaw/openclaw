import { describe, expect, it } from "vitest";
import { filterByFuzzy, fuzzyScorePart, scoreCommand, type Scorable } from "./fuzzy-search";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function cmd(id: string, label: string, category?: string): Scorable {
  return { id, label, category };
}

function labels(items: Scorable[]): string[] {
  return items.map((i) => i.label);
}

// ---------------------------------------------------------------------------
// fuzzyScorePart
// ---------------------------------------------------------------------------
describe("fuzzyScorePart", () => {
  it("returns 0 for empty query", () => {
    expect(fuzzyScorePart("", "hello")).toBe(0);
    expect(fuzzyScorePart("  ", "hello")).toBe(0);
  });

  it("returns 0 for empty text", () => {
    expect(fuzzyScorePart("hello", "")).toBe(0);
    expect(fuzzyScorePart("hello", "  ")).toBe(0);
  });

  it("gives highest score for exact match", () => {
    expect(fuzzyScorePart("chat", "chat")).toBe(1000);
  });

  it("is case-insensitive for exact match", () => {
    expect(fuzzyScorePart("Chat", "chat")).toBe(1000);
    expect(fuzzyScorePart("CHAT", "chat")).toBe(1000);
  });

  it("gives high score for prefix match", () => {
    const score = fuzzyScorePart("go", "Go to Chat");
    expect(score).toBe(700);
  });

  it("gives moderate score for substring match", () => {
    const score = fuzzyScorePart("chat", "Go to Chat");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(700); // less than prefix
  });

  it("penalises late substring matches", () => {
    const early = fuzzyScorePart("ab", "ab is here among many words");
    const late = fuzzyScorePart("many", "ab is here among many words");
    expect(early).toBeGreaterThan(late);
  });

  it("gives positive score for fuzzy in-order character match", () => {
    // "gt" matches "Go to" via g...t
    const score = fuzzyScorePart("gt", "Go to Chat");
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 when characters cannot be matched in order", () => {
    expect(fuzzyScorePart("zx", "Go to Chat")).toBe(0);
  });

  it("rewards consecutive character matches", () => {
    const consecutive = fuzzyScorePart("go", "a good thing");
    const scattered = fuzzyScorePart("gi", "a good thing");
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("rewards word-boundary matches", () => {
    // Compare two fuzzy (non-substring) matches where one has boundary
    // alignment and the other doesn't.
    // "gc" in "go chat" — g at position 0 (boundary), c at position 3 (boundary)
    // "gc" in "organic" — g at position 2 (not boundary), c at position 5 (not boundary)
    const boundary = fuzzyScorePart("gc", "go chat");
    const noBoundary = fuzzyScorePart("gc", "organic");
    expect(boundary).toBeGreaterThan(noBoundary);
  });

  it("prefers shorter strings for fuzzy matches", () => {
    // Length penalty applies to fuzzy (non-substring) matches.
    // "xz" fuzzy-matches both strings, but shorter one gets less penalty.
    const short = fuzzyScorePart("xz", "xyzw");
    const long = fuzzyScorePart("xz", "xyzwabcdefghijklmnopqrstuvw");
    expect(short).toBeGreaterThan(long);
  });

  it("handles single character queries", () => {
    expect(fuzzyScorePart("g", "Go to Chat")).toBeGreaterThan(0);
  });

  it("handles queries with special delimiter characters", () => {
    expect(fuzzyScorePart("nav", "nav-chat")).toBe(700);
    expect(fuzzyScorePart("nav", "nav_chat")).toBe(700);
  });

  it("exact > prefix > substring > fuzzy ordering", () => {
    const exact = fuzzyScorePart("chat", "chat");
    const prefix = fuzzyScorePart("chat", "chat room");
    const substring = fuzzyScorePart("chat", "go to chat");
    const fuzzy = fuzzyScorePart("cht", "chat");

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
  });
});

// ---------------------------------------------------------------------------
// scoreCommand
// ---------------------------------------------------------------------------
describe("scoreCommand", () => {
  const navChat = cmd("nav-chat", "Go to Chat", "Navigation");
  const toggleTheme = cmd("theme-toggle", "Toggle Theme", "Actions");

  it("returns 0 for empty query", () => {
    expect(scoreCommand(navChat, "")).toBe(0);
    expect(scoreCommand(navChat, "   ")).toBe(0);
  });

  it("scores based on label match", () => {
    const score = scoreCommand(navChat, "chat");
    expect(score).toBeGreaterThan(0);
  });

  it("scores based on category match", () => {
    const score = scoreCommand(navChat, "navigation");
    expect(score).toBeGreaterThan(0);
  });

  it("scores based on id match (with lower weight)", () => {
    const score = scoreCommand(navChat, "nav-chat");
    expect(score).toBeGreaterThan(0);
  });

  it("label match scores higher than category match for equal match quality", () => {
    // When both have a prefix-level match, label (1×) should beat category (0.8×).
    const labelCmd = cmd("x", "Config Settings", "Other");
    const catCmd = cmd("x", "Other Settings", "Config");

    const labelScore = scoreCommand(labelCmd, "config");
    const catScore = scoreCommand(catCmd, "config");

    // labelCmd: label prefix match = 700.  catCmd: category exact match = 1000*0.8 = 800.
    // With an exact category match, category can legitimately win — that's expected.
    // But for a prefix label vs prefix category (same quality), label wins.
    // So use a query that is a prefix of both label and category:
    const labelCmd2 = cmd("x", "Toggle it", "Other");
    const catCmd2 = cmd("x", "Other", "Toggle it");

    const l2 = scoreCommand(labelCmd2, "toggle");
    const c2 = scoreCommand(catCmd2, "toggle");
    expect(l2).toBeGreaterThan(c2);
  });

  it("supports multi-term queries", () => {
    const score = scoreCommand(navChat, "go chat");
    expect(score).toBeGreaterThan(0);
  });

  it("rejects if any term has no match", () => {
    const score = scoreCommand(navChat, "go zzzzz");
    expect(score).toBe(0);
  });

  it("handles command without category", () => {
    const noCategory = cmd("test", "Test Label");
    expect(scoreCommand(noCategory, "test")).toBeGreaterThan(0);
  });

  it("accumulates scores across multiple terms", () => {
    const single = scoreCommand(navChat, "chat");
    const multi = scoreCommand(navChat, "go chat");
    // Multi-term should have higher total (both terms contribute)
    expect(multi).toBeGreaterThan(single);
  });
});

// ---------------------------------------------------------------------------
// filterByFuzzy
// ---------------------------------------------------------------------------
describe("filterByFuzzy", () => {
  const commands: Scorable[] = [
    cmd("nav-chat", "Go to Chat", "Navigation"),
    cmd("nav-overview", "Go to Overview", "Navigation"),
    cmd("nav-sessions", "Go to Sessions", "Navigation"),
    cmd("action-refresh", "Refresh Current View", "Actions"),
    cmd("action-new-session", "New Chat Session", "Actions"),
    cmd("theme-toggle", "Toggle Theme", "Actions"),
    cmd("nav-config", "Go to Config", "Navigation"),
    cmd("nav-debug", "Go to Debug", "Navigation"),
    cmd("nav-logs", "Go to Logs", "Navigation"),
  ];

  it("returns all items when query is empty", () => {
    const result = filterByFuzzy(commands, "");
    expect(result).toHaveLength(commands.length);
    expect(result).toEqual(commands);
  });

  it("returns all items when query is whitespace", () => {
    const result = filterByFuzzy(commands, "   ");
    expect(result).toEqual(commands);
  });

  it("filters to matching items", () => {
    const result = filterByFuzzy(commands, "chat");
    const resultLabels = labels(result);
    expect(resultLabels).toContain("Go to Chat");
    expect(resultLabels).toContain("New Chat Session");
    // Items without "chat" in label/category/id should be excluded
    expect(resultLabels).not.toContain("Toggle Theme");
  });

  it("sorts results by relevance (best match first)", () => {
    const result = filterByFuzzy(commands, "toggle");
    const resultLabels = labels(result);
    // "Toggle Theme" has "toggle" as a prefix — should rank first
    expect(resultLabels[0]).toBe("Toggle Theme");
  });

  it("handles prefix queries", () => {
    const result = filterByFuzzy(commands, "go");
    expect(result.length).toBeGreaterThan(0);
    // All "Go to" commands should match
    for (const r of result) {
      expect(r.label.toLowerCase()).toContain("go");
    }
  });

  it("handles fuzzy queries", () => {
    // "gch" should match "Go to Chat" via g...c...h (fuzzy)
    const result = filterByFuzzy(commands, "gch");
    expect(labels(result)).toContain("Go to Chat");
  });

  it("returns empty array when nothing matches", () => {
    const result = filterByFuzzy(commands, "zzzzz");
    expect(result).toEqual([]);
  });

  it("handles multi-term queries", () => {
    const result = filterByFuzzy(commands, "new session");
    expect(labels(result)).toContain("New Chat Session");
  });

  it("preserves original order for tied scores", () => {
    const tied: Scorable[] = [
      cmd("a", "Foo Bar"),
      cmd("b", "Foo Bar"),
      cmd("c", "Foo Bar"),
    ];
    const result = filterByFuzzy(tied, "foo");
    expect(labels(result)).toEqual(["Foo Bar", "Foo Bar", "Foo Bar"]);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("matches by category", () => {
    const result = filterByFuzzy(commands, "actions");
    const resultLabels = labels(result);
    expect(resultLabels).toContain("Refresh Current View");
    expect(resultLabels).toContain("New Chat Session");
    expect(resultLabels).toContain("Toggle Theme");
  });

  it("ranks exact label match above category match", () => {
    const items: Scorable[] = [
      cmd("x", "Other", "Config"),
      cmd("y", "Config", "Other"),
    ];
    const result = filterByFuzzy(items, "config");
    expect(result[0].id).toBe("y"); // exact label match wins
  });

  it("works with single-character query", () => {
    const result = filterByFuzzy(commands, "t");
    expect(result.length).toBeGreaterThan(0);
    expect(labels(result)).toContain("Toggle Theme");
  });

  it("is case insensitive", () => {
    const upper = filterByFuzzy(commands, "CHAT");
    const lower = filterByFuzzy(commands, "chat");
    const mixed = filterByFuzzy(commands, "ChAt");
    expect(labels(upper)).toEqual(labels(lower));
    expect(labels(lower)).toEqual(labels(mixed));
  });

  it("handles query with leading/trailing whitespace", () => {
    const result = filterByFuzzy(commands, "  chat  ");
    expect(labels(result)).toContain("Go to Chat");
  });
});
