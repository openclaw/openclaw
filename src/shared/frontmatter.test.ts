import { describe, expect, it } from "vitest";
import { normalizeStringList } from "./frontmatter.js";

describe("normalizeStringList", () => {
  it("normalizes string to array", () => {
    expect(normalizeStringList("test")).toEqual(["test"]);
  });

  it("normalizes array to array", () => {
    expect(normalizeStringList(["a", "b"])).toEqual(["a", "b"]);
  });
});
