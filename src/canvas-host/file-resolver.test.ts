import { describe, expect, it } from "vitest";
import { normalizeUrlPath } from "./file-resolver.js";

describe("normalizeUrlPath", () => {
  it("decodes a percent-encoded path", () => {
    expect(normalizeUrlPath("/foo%20bar")).toBe("/foo bar");
  });

  it("normalizes path traversal", () => {
    expect(normalizeUrlPath("/a/../b")).toBe("/b");
  });

  it("falls back to raw path on malformed percent encoding", () => {
    const result = normalizeUrlPath("/bad%ZZpath");
    expect(result).toBe("/bad%ZZpath");
  });

  it("returns / for empty input", () => {
    expect(normalizeUrlPath("")).toBe("/");
  });
});
