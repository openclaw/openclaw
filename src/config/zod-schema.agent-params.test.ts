import { describe, expect, it } from "vitest";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("AgentEntrySchema params field", () => {
  it("accepts agents.list[].params with cacheRetention", () => {
    const result = AgentEntrySchema.safeParse({
      id: "main",
      params: { cacheRetention: "none" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({ cacheRetention: "none" });
    }
  });

  it("accepts agents.list[].params with arbitrary model overrides", () => {
    const result = AgentEntrySchema.safeParse({
      id: "main",
      params: { temperature: 0.7, maxTokens: 4096 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({ temperature: 0.7, maxTokens: 4096 });
    }
  });

  it("accepts agents.list[] without params (optional)", () => {
    const result = AgentEntrySchema.safeParse({
      id: "main",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toBeUndefined();
    }
  });
});
