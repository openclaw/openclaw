import { describe, expect, it } from "vitest";
import { formatAllowlistMatchMeta } from "./allowlist-match.js";

describe("formatAllowlistMatchMeta", () => {
  it("formats with both matchKey and matchSource", () => {
    expect(formatAllowlistMatchMeta({ matchKey: "abc", matchSource: "id" })).toBe(
      "matchKey=abc matchSource=id",
    );
  });

  it("returns none for undefined match", () => {
    expect(formatAllowlistMatchMeta(undefined)).toBe("matchKey=none matchSource=none");
  });

  it("returns none for null match", () => {
    expect(formatAllowlistMatchMeta(null)).toBe("matchKey=none matchSource=none");
  });

  it("returns none for missing keys", () => {
    expect(formatAllowlistMatchMeta({})).toBe("matchKey=none matchSource=none");
  });

  it("handles partial match (matchKey only)", () => {
    expect(formatAllowlistMatchMeta({ matchKey: "abc" })).toBe("matchKey=abc matchSource=none");
  });

  it("handles partial match (matchSource only)", () => {
    expect(formatAllowlistMatchMeta({ matchSource: "tag" })).toBe("matchKey=none matchSource=tag");
  });
});
