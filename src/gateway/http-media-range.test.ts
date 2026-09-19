import { describe, expect, test } from "vitest";
import { hasExplicitAcceptableMediaRange } from "./http-media-range.js";

describe("session history Accept parsing", () => {
  test.each([
    { accept: undefined, expected: false, name: "missing field" },
    { accept: "", expected: false, name: "empty field" },
    { accept: "application/json", expected: false, name: "JSON only" },
    { accept: "text/event-stream", expected: true, name: "exact media type" },
    { accept: "TEXT/EVENT-STREAM", expected: true, name: "case-insensitive media type" },
    { accept: "  text/event-stream  ", expected: true, name: "optional whitespace" },
    { accept: "text/event-stream;", expected: true, name: "omitted trailing parameter" },
    {
      accept: "text/event-stream; ; q=0.5;",
      expected: true,
      name: "omitted parameter slots",
    },
    {
      accept: "text/event-stream; charset=utf-8",
      expected: true,
      name: "media parameter",
    },
    {
      accept: 'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
      expected: false,
      name: "quoted and escaped unmatched parameter delimiters",
    },
    {
      accept: 'text/event-stream; profile="quoted,comma;semicolon\\\"quote"; q=0.5',
      expected: true,
      name: "quoted and escaped matching parameter delimiters",
      representation: 'text/event-stream; profile="quoted,comma;semicolon\\\"quote"',
    },
    {
      accept: 'text/event-stream; profile="https://example.test/profile"',
      expected: false,
      name: "case-sensitive parameter mismatch",
      representation: 'text/event-stream; profile="https://example.test/Profile"',
    },
    {
      accept: "text/event-stream; charset=UTF-8",
      expected: true,
      name: "case-insensitive charset parameter",
    },
    { accept: "text/event-stream;q=0.001", expected: true, name: "minimum positive qvalue" },
    { accept: "text/event-stream;Q=1.000", expected: true, name: "maximum qvalue" },
    {
      accept: "application/json, text/event-stream;q=0.5",
      expected: true,
      name: "explicit media range in a list",
    },
    {
      accept: "text/event-stream;q=0, text/event-stream;q=0.5",
      expected: true,
      name: "duplicate exact ranges with a positive quality",
    },
    {
      accept: "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
      expected: false,
      name: "more-specific matching parameter rejection",
    },
    {
      accept: "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
      expected: true,
      name: "more-specific matching parameter acceptance",
    },
    {
      accept: "text/event-stream;q=0.5;charset=utf-8",
      expected: true,
      name: "matching media parameter after q",
    },
    {
      accept: "text/event-stream;q=1;charset=utf-16",
      expected: false,
      name: "mismatched media parameter after q",
    },
    {
      accept: "text/event-stream; charset=utf-16",
      expected: false,
      name: "mismatched representation parameter",
    },
    { accept: "text/event-streaming", expected: false, name: "lookalike subtype" },
    { accept: "text/event-streamx", expected: false, name: "suffixed subtype" },
    {
      accept: 'application/json; note="text/event-stream"',
      expected: false,
      name: "quoted parameter decoy",
    },
    { accept: "text/*", expected: false, name: "type wildcard" },
    { accept: "*/*", expected: false, name: "all wildcard" },
    { accept: "text/event-stream;q=0", expected: false, name: "zero qvalue" },
    { accept: "text/event-stream;q=0.000", expected: false, name: "zero decimal qvalue" },
    {
      accept: "text/event-stream;q=0, */*;q=1",
      expected: false,
      name: "explicit rejection overriding wildcard",
    },
    { accept: "text/event-stream;q=.5", expected: false, name: "missing leading zero" },
    { accept: "text/event-stream;q =0.5", expected: false, name: "whitespace before equals" },
    { accept: "text/event-stream;q= 0.5", expected: false, name: "whitespace after equals" },
    {
      accept: "text/event-stream;\u00a0q=0.5",
      expected: false,
      name: "non-HTTP parameter whitespace",
    },
    { accept: "text/event-stream;q=0.1234", expected: false, name: "too many q digits" },
    { accept: "text/event-stream;q=1.001", expected: false, name: "qvalue above one" },
    { accept: "text/event-stream;q=1e0", expected: false, name: "exponent qvalue" },
    { accept: 'text/event-stream;q="0.5"', expected: false, name: "quoted qvalue" },
    { accept: "text/event-stream;q=0.5;q=1", expected: false, name: "duplicate q parameter" },
    {
      accept: 'text/event-stream;q=0.5;legacy;note="quoted,comma;semicolon"',
      expected: false,
      name: "obsolete bare Accept extension after q",
    },
    {
      accept: 'text/event-stream; note="unterminated',
      expected: false,
      name: "unterminated quoted parameter",
    },
  ])("returns $expected for $name", ({ accept, expected, representation }) => {
    expect(
      hasExplicitAcceptableMediaRange(accept, representation ?? "text/event-stream; charset=utf-8"),
    ).toBe(expected);
  });
});
