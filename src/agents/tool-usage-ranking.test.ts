import { describe, expect, it } from "vitest";
import { selectUsageRankedToolRows, type ToolUsageRankingSnapshot } from "./tool-usage-ranking.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const at = 20 * DAY_MS;
const rows = ["core", "a", "b", "c", "d", "e", "new_a", "new_b", "new_c"].map((id) => ({
  id,
  line: id.padEnd(9),
  pinned: id === "core",
}));

function select(snapshot: ToolUsageRankingSnapshot, candidates = rows, maxChars = 100) {
  return selectUsageRankedToolRows(candidates, snapshot, maxChars, () => 30).map((row) => row.id);
}

describe("frozen tool usage selection", () => {
  it("pins core, reserves 20% of characters for newcomers, and renders in canonical order", () => {
    const snapshot: ToolUsageRankingSnapshot = {
      version: 1,
      at,
      orderedToolIds: ["e", "d", "c", "b", "a", "not-authorized"],
      newcomers: { new_c: at, new_b: at, new_a: at - 14 * DAY_MS },
    };
    expect(select(snapshot)).toEqual(["core", "b", "c", "d", "e", "new_a", "new_b"]);
    expect(select({ ...snapshot, orderedToolIds: ["b", "c", "d", "e", "a"] })).toEqual(
      select(snapshot),
    );
  });

  it("returns unused reserve, ignores expired/history-bearing newcomers, and uses frozen time", () => {
    const snapshot: ToolUsageRankingSnapshot = {
      version: 1,
      at,
      orderedToolIds: ["e", "d", "c", "b", "a", "new_c"],
      newcomers: { new_a: at - 14 * DAY_MS - 1, new_c: at, new_b: at + DAY_MS },
    };
    expect(select(snapshot)).toEqual(["core", "a", "b", "c", "d", "e", "new_b"]);
    expect(select({ ...snapshot, newcomers: {} })).toEqual([
      "core",
      "a",
      "b",
      "c",
      "d",
      "e",
      "new_c",
    ]);
  });

  it("skips oversized rows, charges actual characters, and keeps unmatched tools deterministic", () => {
    const candidates = [{ id: "oversized", line: "x".repeat(100), pinned: false }, ...rows];
    const snapshot: ToolUsageRankingSnapshot = {
      version: 1,
      at,
      orderedToolIds: ["oversized", "e"],
      newcomers: { new_a: at, new_b: at },
    };
    expect(select(snapshot, candidates, 65)).toEqual(["core", "e", "new_a"]);
    expect(select({ ...snapshot, newcomers: {} }, candidates, 65)).toEqual(["core", "a", "e"]);
  });
});
