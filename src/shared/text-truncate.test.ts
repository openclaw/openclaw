import { describe, expect, it } from "vitest";
import {
  compactProgressText,
  truncateOptionalText,
  truncateUtf16WithEllipsis,
} from "./text-truncate.js";

describe("compactProgressText", () => {
  it.each([
    {
      name: "keeps a complete final word at the boundary",
      text: "Inspect the working tree and check important.json before continuing",
      maxChars: 50,
      expected: "Inspect the working tree and check important.json…",
    },
    {
      name: "backs off a partial final word",
      text: "Inspect the working tree and check important.json before continuing",
      maxChars: 59,
      expected: "Inspect the working tree and check important.json before…",
    },
    {
      name: "counts astral characters when deciding whether to back off",
      text: `${"𠮷".repeat(40)} ${"x".repeat(100)}`,
      maxChars: 120,
      expected: `${"𠮷".repeat(40)} ${"x".repeat(78)}…`,
    },
  ])("$name", ({ text, maxChars, expected }) => {
    expect(compactProgressText(text, maxChars)).toBe(expected);
  });
});

describe("truncateOptionalText", () => {
  it.each([
    { value: undefined, maxLength: 4, expected: undefined },
    { value: " \n ", maxLength: 4, expected: undefined },
    { value: " abcd ", maxLength: 4, expected: "abcd" },
    { value: " abcdef ", maxLength: 4, expected: "abcd" },
    { value: " abc ", maxLength: 0, expected: "" },
    { value: " a😀bc ", maxLength: 2, expected: "a" },
    { value: " ab  cd ", maxLength: 4, expected: "ab  " },
  ])("clips $value at $maxLength after trimming", ({ value, maxLength, expected }) => {
    expect(truncateOptionalText(value, maxLength)).toBe(expected);
  });
});

describe("truncateUtf16WithEllipsis", () => {
  it.each([
    { name: "keeps text at the boundary", value: "abcd", maxLength: 4, expected: "abcd" },
    { name: "adds an ellipsis", value: "abcdef", maxLength: 4, expected: "abc…" },
    { name: "returns empty for a negative limit", value: "abc", maxLength: -1, expected: "" },
    { name: "returns empty for a zero limit", value: "abc", maxLength: 0, expected: "" },
    { name: "keeps one safe code unit", value: "abc", maxLength: 1, expected: "a" },
    {
      name: "drops a leading surrogate pair at limit one",
      value: "😀a",
      maxLength: 1,
      expected: "",
    },
    { name: "avoids a dangling surrogate at limit two", value: "😀a", maxLength: 2, expected: "…" },
    {
      name: "avoids a dangling surrogate at larger limits",
      value: "a😀bc",
      maxLength: 3,
      expected: "a…",
    },
    {
      name: "preserves whitespace before the marker",
      value: "ab  cd",
      maxLength: 5,
      expected: "ab  …",
    },
  ])("$name", ({ value, maxLength, expected }) => {
    expect(truncateUtf16WithEllipsis(value, maxLength)).toBe(expected);
  });
});
