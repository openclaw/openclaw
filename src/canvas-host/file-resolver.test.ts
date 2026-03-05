import { describe, expect, it } from "vitest";
import { normalizeUrlPath } from "./file-resolver.js";

describe("normalizeUrlPath", () => {
  it("normalizes a simple path", () => {
    expect(normalizeUrlPath("/foo/bar")).toBe("/foo/bar");
  });

  it("returns / for empty string", () => {
    expect(normalizeUrlPath("")).toBe("/");
  });

  it("decodes percent-encoded characters", () => {
    expect(normalizeUrlPath("/hello%20world")).toBe("/hello world");
  });

  it("does not throw on malformed percent-encoding", () => {
    const result = normalizeUrlPath("/%ZZbad");
    expect(result).toBe("/%ZZbad");
  });

  it("does not throw on trailing percent sign", () => {
    const result = normalizeUrlPath("/path%");
    expect(result).toBe("/path%");
  });

  it("normalizes double slashes", () => {
    expect(normalizeUrlPath("//foo//bar")).toBe("/foo/bar");
  });
});
