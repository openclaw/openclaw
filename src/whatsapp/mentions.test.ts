import { describe, expect, it } from "vitest";
import { extractMentions } from "./mentions.js";

describe("extractMentions", () => {
  it("extracts a single mention", () => {
    expect(extractMentions("Hello @5541999990000")).toEqual(["5541999990000@s.whatsapp.net"]);
  });

  it("extracts multiple mentions", () => {
    expect(extractMentions("@5541999990000 and @5541988880000 check this")).toEqual([
      "5541999990000@s.whatsapp.net",
      "5541988880000@s.whatsapp.net",
    ]);
  });

  it("returns empty array for text without mentions", () => {
    expect(extractMentions("Hello world")).toEqual([]);
  });

  it("returns empty array for null/undefined", () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractMentions("")).toEqual([]);
  });

  it("ignores @ followed by too few digits", () => {
    expect(extractMentions("email @123456789")).toEqual([]);
  });

  it("captures up to 15 digits from a longer number", () => {
    // regex matches the first 15 digits; the 16th is left out
    expect(extractMentions("@1234567890123456")).toEqual(["123456789012345@s.whatsapp.net"]);
  });

  it("de-duplicates repeated mentions", () => {
    expect(extractMentions("@5541999990000 hey @5541999990000")).toEqual([
      "5541999990000@s.whatsapp.net",
    ]);
  });

  it("extracts mention from caption-like text", () => {
    expect(extractMentions("Check this image @5541999990000!")).toEqual([
      "5541999990000@s.whatsapp.net",
    ]);
  });
});
