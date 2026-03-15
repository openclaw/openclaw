import { describe, expect, it } from "vitest";
import { MarkdownTableModeSchema } from "./zod-schema.core.js";

describe("MarkdownTableModeSchema", () => {
  it("accepts all valid table modes", () => {
    expect(MarkdownTableModeSchema.parse("off")).toBe("off");
    expect(MarkdownTableModeSchema.parse("bullets")).toBe("bullets");
    expect(MarkdownTableModeSchema.parse("code")).toBe("code");
    expect(MarkdownTableModeSchema.parse("block")).toBe("block");
  });

  it("rejects invalid values", () => {
    expect(() => MarkdownTableModeSchema.parse("invalid")).toThrow();
    expect(() => MarkdownTableModeSchema.parse("")).toThrow();
  });
});
