import { expect, it } from "vitest";
import { matchFoldedQuery } from "./text-match.ts";

it.each([
  ["김민수", "미", "민"],
  ["Kim 민수 Lee", "lee", "Lee"],
  ["José García".normalize("NFD"), "garci", "Garcí".normalize("NFD")],
  ["ΝΙΚΟΣ", " κος ", "ΚΟΣ"],
  ["Ada", "", undefined],
])("maps the folded match in %j for %j to source text", (text, query, expected) => {
  const match = matchFoldedQuery(text, query);
  expect(match ? text.slice(match.start, match.end) : undefined).toBe(expected);
});
