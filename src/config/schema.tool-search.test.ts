import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";

describe("Tool Search config", () => {
  it("accepts simplified Tool Search config in the runtime zod schema", () => {
    expect(ToolsSchema.parse({ toolSearch: true })?.toolSearch).toBe(true);
    expect(
      ToolsSchema.parse({
        toolSearch: {
          enabled: true,
          mode: "directory",
          codeTimeoutMs: 5000,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
          semanticRanking: "shadow",
          semanticRankingTimeoutMs: 1200,
        },
      })?.toolSearch,
    ).toEqual({
      enabled: true,
      mode: "directory",
      codeTimeoutMs: 5000,
      searchDefaultLimit: 4,
      maxSearchLimit: 12,
      semanticRanking: "shadow",
      semanticRankingTimeoutMs: 1200,
    });
    expect(
      ToolsSchema.safeParse({
        toolSearch: {
          enabled: true,
          mode: "both",
        },
      }).success,
    ).toBe(false);
  });
});
