import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema suppressPreToolText", () => {
  it("accepts { suppressPreToolText: true }", () => {
    const result = AgentDefaultsSchema.safeParse({ suppressPreToolText: true });
    expect(result.success).toBe(true);
  });

  it("accepts { suppressPreToolText: false }", () => {
    const result = AgentDefaultsSchema.safeParse({ suppressPreToolText: false });
    expect(result.success).toBe(true);
  });

  it("accepts {} (optional, no suppressPreToolText)", () => {
    const result = AgentDefaultsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects { suppressPreToolText: "yes" } (boolean, not string)', () => {
    const result = AgentDefaultsSchema.safeParse({ suppressPreToolText: "yes" });
    expect(result.success).toBe(false);
  });
});
