import { expect, it } from "vitest";
import { fnv1aUtf16 } from "./fnv1a.js";

it.each([
  ["", 2166136261],
  ["a", 3826002220],
  ["hello", 1335831723],
  ["foobar", 3214735720],
  ["🦞", 3677094317],
  ["a\u0000b", 284404690],
  ["\ud800", 75617567],
] as const)("preserves unsigned UTF-16 FNV-1a for %j", (value, expected) => {
  expect(fnv1aUtf16(value)).toBe(expected);
});
