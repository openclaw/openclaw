import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts contextInjection: 'always'", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "always" })!;
    expect(result.contextInjection).toBe("always");
  });

  it("accepts contextInjection: 'continuation-skip'", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "continuation-skip" })!;
    expect(result.contextInjection).toBe("continuation-skip");
  });

  it("rejects invalid contextInjection value", () => {
    expect(() => AgentDefaultsSchema.parse({ contextInjection: "never" })).toThrow();
  });

  it("accepts omitted contextInjection", () => {
    const result = AgentDefaultsSchema.parse({})!;
    expect(result.contextInjection).toBeUndefined();
  });
});
