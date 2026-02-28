import { describe, expect, it } from "vitest";
import { normalizeStringList } from "./frontmatter.js";

describe("normalizeStringList", () => {
  it("normalizes string input to array", () => {
    expect(normalizeStringList("test")).toEqual(["test"]);
  });
});
