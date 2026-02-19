import { describe, expect, it } from "vitest";
import { formatAllowlistEntries, parseAllowlistEntries } from "./channel-access.js";

describe("parseAllowlistEntries", () => {
  it("parses comma-separated entries", () => {
    expect(parseAllowlistEntries("#general, #random, #dev")).toEqual([
      "#general",
      "#random",
      "#dev",
    ]);
  });

  it("parses space-separated entries", () => {
    // User entered "#ryan #openclaw-discussion" without commas
    expect(parseAllowlistEntries("#ryan #openclaw-discussion")).toEqual([
      "#ryan",
      "#openclaw-discussion",
    ]);
  });

  it("parses semicolon-separated entries", () => {
    expect(parseAllowlistEntries("#chan1; #chan2; #chan3")).toEqual(["#chan1", "#chan2", "#chan3"]);
  });

  it("parses newline-separated entries", () => {
    expect(parseAllowlistEntries("#chan1\n#chan2\n#chan3")).toEqual(["#chan1", "#chan2", "#chan3"]);
  });

  it("handles mixed separators", () => {
    expect(parseAllowlistEntries("#a, #b #c; #d\n#e")).toEqual(["#a", "#b", "#c", "#d", "#e"]);
  });

  it("handles channel IDs", () => {
    expect(parseAllowlistEntries("C123 C456, C789")).toEqual(["C123", "C456", "C789"]);
  });

  it("trims whitespace from entries", () => {
    expect(parseAllowlistEntries("  #general  ,  #random  ")).toEqual(["#general", "#random"]);
  });

  it("filters empty entries", () => {
    expect(parseAllowlistEntries("#general,, ,#random")).toEqual(["#general", "#random"]);
  });

  it("handles empty input", () => {
    expect(parseAllowlistEntries("")).toEqual([]);
    expect(parseAllowlistEntries(null as unknown as string)).toEqual([]);
    expect(parseAllowlistEntries(undefined as unknown as string)).toEqual([]);
  });

  it("handles single entry", () => {
    expect(parseAllowlistEntries("#general")).toEqual(["#general"]);
  });
});

describe("formatAllowlistEntries", () => {
  it("formats entries as comma-separated string", () => {
    expect(formatAllowlistEntries(["#general", "#random", "#dev"])).toBe("#general, #random, #dev");
  });

  it("trims entries", () => {
    expect(formatAllowlistEntries(["  #general  ", "  #random  "])).toBe("#general, #random");
  });

  it("filters empty entries", () => {
    expect(formatAllowlistEntries(["#general", "", "  ", "#random"])).toBe("#general, #random");
  });

  it("handles empty array", () => {
    expect(formatAllowlistEntries([])).toBe("");
  });
});
