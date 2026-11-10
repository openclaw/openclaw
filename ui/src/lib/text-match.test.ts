import { describe, expect, it } from "vitest";
import { matchFoldedQuery } from "./text-match.ts";

function highlight(text: string, query: string) {
  const match = matchFoldedQuery(text, query);
  return match ? text.slice(match.start, match.end) : null;
}

describe("matchFoldedQuery", () => {
  it.each([
    ["José García", "garcia", "García"],
    ["José García".normalize("NFD"), "garcia", "García".normalize("NFD")],
    ["김민수", "민", "민"],
    ["Kim 민수 Lee", "Lee", "Lee"],
    ["Ada", "  a  ", "A"],
    ["ΝΙΚΟΣ", "κος", "ΚΟΣ"],
  ])("maps the match in %j for %j back to source text", (text, query, expected) => {
    expect(highlight(text, query)).toBe(expected);
  });

  it.each([
    ["Ada", ""],
    ["Ada", "x"],
  ])("returns null for %j with query %j", (text, query) => {
    expect(matchFoldedQuery(text, query)).toBeNull();
  });
});
