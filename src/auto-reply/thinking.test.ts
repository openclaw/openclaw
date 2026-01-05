import { describe, expect, it } from "vitest";
import { normalizeThinkLevel } from "./thinking.js";

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });
});
