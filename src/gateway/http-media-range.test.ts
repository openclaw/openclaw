import { describe, expect, test } from "vitest";
import { hasExplicitAcceptableMediaRange } from "./http-media-range.js";

describe("session history Accept parsing", () => {
  test.each([
    { accept: undefined, expected: false, name: "missing field" },
    { accept: "application/json", expected: false, name: "JSON only" },
    {
      accept: "text/event-stream; ; q=0.5;",
      expected: true,
      name: "omitted parameter slots",
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
    {
      accept: "application/json, text/event-stream;q=0.5",
      expected: true,
      name: "explicit media range in a list",
    },
    { accept: "text/event-stream;q=0.000", expected: false, name: "zero decimal qvalue" },
    { accept: "text/event-stream;q=.5", expected: false, name: "missing leading zero" },
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
